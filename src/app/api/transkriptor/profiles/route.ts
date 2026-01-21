import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { randomUUID } from "crypto";

type ProfileRecord = {
  profileKey: string;
  speakerName: string;
  profileId?: string;
  createdAt: string;
  active: boolean;
  audioKey?: string;
  transkriptorUploadUrl?: string;
  transkriptorResponse?: any;
  transkriptorDeleteResponse?: any;
  archivedAt?: string;
  profileSummary?: string;
};

const TRANSKRIPTOR_BASE =
  process.env.TRANSKRIPTOR_BASE_URL?.replace(/\/$/, "") ||
  "https://api.tor.app/developer";

const S3_BUCKET = process.env.TRANSKRIPTOR_S3_BUCKET || process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || "eu-west-2";
const PROFILE_PREFIX = "chatbot-livetranscribe/profiles";

function getS3Client() {
  return new S3Client({ region: S3_REGION });
}

async function streamToString(body: any): Promise<string> {
  if (!body) return "";
  if (typeof body.transformToString === "function") {
    return body.transformToString();
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body as any).toString("utf-8");
  }
  return String(body);
}

async function fetchTranskriptor(path: string, init: RequestInit): Promise<any> {
  const apiKey = process.env.TRANSKRIPTOR_API_KEY;
  if (!apiKey) {
    throw new Error("TRANSKRIPTOR_API_KEY is not set");
  }

  const resp = await fetch(`${TRANSKRIPTOR_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(init.headers || {}),
    },
  });

  const text = await resp.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!resp.ok) {
    const error = new Error(`Transkriptor error ${resp.status}`);
    (error as any).data = data;
    throw error;
  }

  return data;
}

async function listProfileMetas(): Promise<ProfileRecord[]> {
  if (!S3_BUCKET) return [];
  const client = getS3Client();
  const results: ProfileRecord[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const listResp: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${PROFILE_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    continuationToken = listResp.NextContinuationToken;
    const metas =
      listResp.Contents?.filter((obj) => obj.Key?.endsWith("/meta.json")) || [];

    for (const meta of metas) {
      if (!meta.Key) continue;
      const getResp = await client.send(
        new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: meta.Key,
        }),
      );
      const bodyStr = await streamToString(getResp.Body);
      try {
        results.push(JSON.parse(bodyStr));
      } catch {
        // skip corrupt record
      }
    }
  } while (continuationToken);

  // sort newest first
  return results.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
}

export async function GET() {
  try {
    const profiles = await listProfileMetas();
    return NextResponse.json({ profiles });
  } catch (err: any) {
    console.error("List profiles failed", err);
    return NextResponse.json(
      { error: "Failed to list profiles", details: err?.message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!S3_BUCKET) {
    return NextResponse.json(
      { error: "S3_BUCKET (or TRANSKRIPTOR_S3_BUCKET) env var is not set" },
      { status: 500 },
    );
  }

  try {
    const { speakerName, audioBase64, profileSummary } = await request.json();
    if (!speakerName || typeof speakerName !== "string") {
      return NextResponse.json(
        { error: "speakerName is required" },
        { status: 400 },
      );
    }
    if (!audioBase64 || typeof audioBase64 !== "string") {
      return NextResponse.json(
        { error: "audioBase64 is required" },
        { status: 400 },
      );
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Step 1: create upload URL
    const uploadData = await fetchTranskriptor(
      "/annotations/profiles/create_url",
      {
        method: "POST",
        body: JSON.stringify({ speaker_name: speakerName }),
      },
    );
    const uploadUrl = uploadData?.upload_url;
    if (!uploadUrl) {
      return NextResponse.json(
        { error: "Transkriptor did not return upload_url", raw: uploadData },
        { status: 502 },
      );
    }

    // Step 2: upload audio to presigned URL
    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: audioBuffer,
    });
    if (!putResp.ok) {
      const body = await putResp.text();
      return NextResponse.json(
        {
          error: "Failed to upload audio to presigned URL",
          status: putResp.status,
          body,
        },
        { status: 502 },
      );
    }

    // Step 3: finalize profile
    const finalize = await fetchTranskriptor("/annotations/profiles", {
      method: "POST",
      body: JSON.stringify({ speaker_name: speakerName }),
    });
    const profileId =
      finalize?.profile_id || finalize?.profileId || finalize?.id;

    // Persist audio + meta for later reactivation
    const profileKey = randomUUID();
    const audioKey = `${PROFILE_PREFIX}/${profileKey}/audio.webm`;
    const metaKey = `${PROFILE_PREFIX}/${profileKey}/meta.json`;

    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: audioKey,
        Body: audioBuffer,
        ContentType: "audio/webm",
      }),
    );

    const record: ProfileRecord = {
      profileKey,
      speakerName,
      profileId,
      createdAt: new Date().toISOString(),
      active: true,
      audioKey,
      transkriptorUploadUrl: uploadUrl,
      transkriptorResponse: finalize,
      profileSummary: profileSummary || undefined,
    };

    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: metaKey,
        Body: JSON.stringify(record),
        ContentType: "application/json",
      }),
    );

    return NextResponse.json({
      profileKey,
      profileId,
      speakerName,
      transkriptorResponse: finalize,
    });
  } catch (err: any) {
    console.error("Create profile failed", err);
    return NextResponse.json(
      { error: "Failed to create profile", details: err?.data || err?.message },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!S3_BUCKET) {
    return NextResponse.json(
      { error: "S3_BUCKET (or TRANSKRIPTOR_S3_BUCKET) env var is not set" },
      { status: 500 },
    );
  }

  try {
    const url = new URL(request.url);
    const profileKey = url.searchParams.get("profileKey");
    const profileId = url.searchParams.get("profileId");
    if (!profileKey && !profileId) {
      return NextResponse.json(
        { error: "profileKey or profileId is required" },
        { status: 400 },
      );
    }

    const profiles = await listProfileMetas();
    const record = profiles.find(
      (p) =>
        (profileKey && p.profileKey === profileKey) ||
        (profileId && p.profileId === profileId),
    );
    if (!record) {
      return NextResponse.json(
        { error: "Profile not found in local registry" },
        { status: 404 },
      );
    }

    // Delete remotely (if possible)
    let deleteResponse: any = null;
    try {
      deleteResponse = await fetchTranskriptor("/annotations/profiles", {
        method: "DELETE",
        body: JSON.stringify({ speaker_name: record.speakerName }),
      });
    } catch (err: any) {
      deleteResponse = err?.data || { error: err?.message };
      // we still mark archived locally even if remote delete fails
    }

    // Update meta to mark inactive/archived
    const client = getS3Client();
    const metaKey = `${PROFILE_PREFIX}/${record.profileKey}/meta.json`;
    const updated: ProfileRecord = {
      ...record,
      active: false,
      archivedAt: new Date().toISOString(),
      transkriptorDeleteResponse: deleteResponse,
    };
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: metaKey,
        Body: JSON.stringify(updated),
        ContentType: "application/json",
      }),
    );

    return NextResponse.json({ ok: true, deleteResponse });
  } catch (err: any) {
    console.error("Delete profile failed", err);
    return NextResponse.json(
      { error: "Failed to delete profile", details: err?.data || err?.message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import type { SessionSetupConfig, SessionSetupSummary } from "@/app/lib/sessionSetupTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const S3_BUCKET = process.env.TRANSKRIPTOR_S3_BUCKET || process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || "eu-west-2";
const SESSION_SETUP_PREFIX = "sessionsetup";
const ACTIVE_KEY = `${SESSION_SETUP_PREFIX}/active.json`;
const S3_ACCESS_KEY_ID =
  process.env.S3_BUCKET_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY =
  process.env.S3_BUCKET_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;
const S3_SESSION_TOKEN =
  process.env.S3_BUCKET_SESSION_TOKEN || process.env.S3_SESSION_TOKEN;

function getS3Client() {
  const creds =
    S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: S3_ACCESS_KEY_ID,
          secretAccessKey: S3_SECRET_ACCESS_KEY,
          sessionToken: S3_SESSION_TOKEN,
        }
      : undefined;
  return new S3Client({ region: S3_REGION, credentials: creds });
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

async function getConfigByKey(key: string): Promise<SessionSetupConfig | null> {
  if (!S3_BUCKET) return null;
  const client = getS3Client();
  const resp = await client.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
    }),
  );
  const bodyStr = await streamToString(resp.Body);
  if (!bodyStr) return null;
  try {
    return JSON.parse(bodyStr);
  } catch {
    return null;
  }
}

async function listSetups(): Promise<SessionSetupSummary[]> {
  if (!S3_BUCKET) return [];
  const client = getS3Client();
  const results: SessionSetupSummary[] = [];
  let continuationToken: string | undefined = undefined;

  do {
    const listResp: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${SESSION_SETUP_PREFIX}/`,
        ContinuationToken: continuationToken,
      }),
    );
    continuationToken = listResp.NextContinuationToken;
    const configs =
      listResp.Contents?.filter(
        (obj) =>
          obj.Key &&
          obj.Key.endsWith(".json") &&
          obj.Key !== ACTIVE_KEY,
      ) || [];

    for (const item of configs) {
      if (!item.Key) continue;
      const cfg = await getConfigByKey(item.Key);
      if (!cfg) continue;
      results.push({
        id: cfg.id,
        name: cfg.name,
        description: cfg.description,
        createdAt: cfg.createdAt,
        updatedAt: cfg.updatedAt,
      });
    }
  } while (continuationToken);

  return results.sort((a, b) =>
    (b.updatedAt || b.createdAt || "").localeCompare(
      a.updatedAt || a.createdAt || "",
    ),
  );
}

export async function GET(request: Request) {
  if (!S3_BUCKET) {
    return NextResponse.json(
      { error: "S3_BUCKET env var is not set" },
      { status: 500 },
    );
  }

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const active = url.searchParams.get("active");

    if (active === "1" || active === "true") {
      const config = await getConfigByKey(ACTIVE_KEY);
      if (!config) {
        return NextResponse.json(
          { error: "Active session setup not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ config });
    }

    if (id) {
      const key = `${SESSION_SETUP_PREFIX}/${id}.json`;
      const config = await getConfigByKey(key);
      if (!config) {
        return NextResponse.json(
          { error: "Session setup not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ config });
    }

    const setups = await listSetups();
    return NextResponse.json({ setups });
  } catch (err: any) {
    console.error("Session setup GET failed", err);
    return NextResponse.json(
      { error: "Failed to fetch session setup", details: err?.message },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (!S3_BUCKET) {
    return NextResponse.json(
      { error: "S3_BUCKET env var is not set" },
      { status: 500 },
    );
  }

  try {
    const body = await request.json();
    const config = body?.config as SessionSetupConfig | undefined;
    const setActive = Boolean(body?.setActive);

    if (!config || !config.id || !config.name || !config.prompts) {
      return NextResponse.json(
        { error: "config with id, name, and prompts is required" },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const normalized: SessionSetupConfig = {
      ...config,
      createdAt: config.createdAt || now,
      updatedAt: now,
    };

    const client = getS3Client();
    const key = `${SESSION_SETUP_PREFIX}/${normalized.id}.json`;
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify(normalized),
        ContentType: "application/json",
      }),
    );

    if (setActive) {
      await client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: ACTIVE_KEY,
          Body: JSON.stringify(normalized),
          ContentType: "application/json",
        }),
      );
    }

    return NextResponse.json({ ok: true, config: normalized });
  } catch (err: any) {
    console.error("Session setup POST failed", err);
    return NextResponse.json(
      { error: "Failed to save session setup", details: err?.message },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  if (!S3_BUCKET) {
    return NextResponse.json(
      { error: "S3_BUCKET env var is not set" },
      { status: 500 },
    );
  }

  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${SESSION_SETUP_PREFIX}/${id}.json`,
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Session setup DELETE failed", err);
    return NextResponse.json(
      { error: "Failed to delete session setup", details: err?.message },
      { status: 500 },
    );
  }
}

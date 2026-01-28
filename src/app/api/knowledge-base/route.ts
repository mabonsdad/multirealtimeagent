import { NextResponse } from "next/server";
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  ListObjectsV2CommandOutput,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const S3_BUCKET = process.env.TRANSKRIPTOR_S3_BUCKET || process.env.S3_BUCKET;
const S3_REGION = process.env.AWS_REGION || "eu-west-2";
const KNOWLEDGE_PREFIX = "knowledgebase";
const S3_ACCESS_KEY_ID =
  process.env.S3_ACCESS_KEY_ID || process.env.S3_BUCKET_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY =
  process.env.S3_SECRET_ACCESS_KEY || process.env.S3_BUCKET_SECRET_ACCESS_KEY;
const S3_SESSION_TOKEN =
  process.env.S3_SESSION_TOKEN || process.env.S3_BUCKET_SESSION_TOKEN;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
]);

function getS3Client() {
  if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    throw new Error("Missing S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY");
  }
  return new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      sessionToken: S3_SESSION_TOKEN,
    },
  });
}

function sanitizeFolder(folder: string) {
  const clean = folder.replace(/^\/+/, "").replace(/\\+/g, "/");
  if (!clean || clean.includes("..")) {
    throw new Error("Invalid folder");
  }
  return clean;
}

function sanitizeFilename(name: string) {
  const clean = name.replace(/[/\\]/g, "_").trim();
  if (!clean) {
    throw new Error("Invalid filename");
  }
  return clean;
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

function isTextFile(name: string) {
  const lower = name.toLowerCase();
  for (const ext of TEXT_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
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
    const folderParam = url.searchParams.get("folder");
    if (!folderParam) {
      return NextResponse.json(
        { error: "folder query param is required" },
        { status: 400 },
      );
    }
    const folder = sanitizeFolder(folderParam);
    const includeContent =
      url.searchParams.get("include") === "content" ||
      url.searchParams.get("include") === "1" ||
      url.searchParams.get("include") === "true";
    const maxParam = Number(url.searchParams.get("max") || "0");
    const maxItems = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : 50;
    const maxCharsParam = Number(url.searchParams.get("maxChars") || "0");
    const maxChars =
      Number.isFinite(maxCharsParam) && maxCharsParam > 0 ? maxCharsParam : 6000;

    const client = getS3Client();
    const prefix = `${KNOWLEDGE_PREFIX}/${folder}/`;
    const listResp: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
      }),
    );
    const contents =
      listResp.Contents?.filter((obj) => obj.Key && obj.Key !== prefix) || [];
    const files = contents
      .map((obj) => ({
        key: obj.Key || "",
        name: obj.Key ? obj.Key.replace(prefix, "") : "",
        size: obj.Size || 0,
        lastModified: obj.LastModified
          ? obj.LastModified.toISOString()
          : undefined,
      }))
      .filter((f) => f.name);

    files.sort((a, b) =>
      (b.lastModified || "").localeCompare(a.lastModified || ""),
    );

    const limited = files.slice(0, maxItems);
    if (!includeContent) {
      return NextResponse.json({ folder, files: limited });
    }

    const withContent = [];
    for (const file of limited) {
      if (!isTextFile(file.name)) {
        withContent.push({ ...file, content: "", truncated: true });
        continue;
      }
      const getResp = await client.send(
        new GetObjectCommand({ Bucket: S3_BUCKET, Key: file.key }),
      );
      const bodyStr = await streamToString(getResp.Body);
      const trimmed =
        bodyStr.length > maxChars ? bodyStr.slice(0, maxChars) : bodyStr;
      withContent.push({
        ...file,
        content: trimmed,
        truncated: bodyStr.length > maxChars,
      });
    }

    return NextResponse.json({ folder, files: withContent });
  } catch (err: any) {
    console.error("Knowledge base GET failed", err);
    return NextResponse.json(
      { error: "Failed to fetch knowledge base", details: err?.message },
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
    const formData = await request.formData();
    const folderParam = String(formData.get("folder") || "");
    const file = formData.get("file") as File | null;

    if (!folderParam || !file) {
      return NextResponse.json(
        { error: "folder and file are required" },
        { status: 400 },
      );
    }

    const folder = sanitizeFolder(folderParam);
    const filename = sanitizeFilename(file.name || "document.txt");
    const key = `${KNOWLEDGE_PREFIX}/${folder}/${filename}`;

    const buffer = Buffer.from(await file.arrayBuffer());
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: file.type || "application/octet-stream",
      }),
    );

    return NextResponse.json({ ok: true, key, name: filename });
  } catch (err: any) {
    console.error("Knowledge base POST failed", err);
    return NextResponse.json(
      { error: "Failed to upload knowledge base doc", details: err?.message },
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
    const folderParam = url.searchParams.get("folder");
    const nameParam = url.searchParams.get("name");
    const keyParam = url.searchParams.get("key");

    let key = keyParam || "";
    if (!key) {
      if (!folderParam || !nameParam) {
        return NextResponse.json(
          { error: "folder and name (or key) are required" },
          { status: 400 },
        );
      }
      const folder = sanitizeFolder(folderParam);
      const filename = sanitizeFilename(nameParam);
      key = `${KNOWLEDGE_PREFIX}/${folder}/${filename}`;
    }

    if (!key.startsWith(`${KNOWLEDGE_PREFIX}/`)) {
      return NextResponse.json(
        { error: "Invalid key" },
        { status: 400 },
      );
    }

    const client = getS3Client();
    await client.send(
      new DeleteObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Knowledge base DELETE failed", err);
    return NextResponse.json(
      { error: "Failed to delete knowledge base doc", details: err?.message },
      { status: 500 },
    );
  }
}

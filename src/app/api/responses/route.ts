import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxy endpoint for the OpenAI Responses API
export async function POST(req: NextRequest) {
  const body = await req.json();

  const rawSecrets =
    typeof process.env.secrets === "string" ? process.env.secrets : "";

  let parsedSecrets: Record<string, string> = {};
  if (rawSecrets) {
    try {
      parsedSecrets = JSON.parse(rawSecrets);
    } catch (err) {
      console.error("Failed to parse process.env.secrets JSON", err);
    }
  }

  const envSecrets = {
    ...parsedSecrets,
    ...((process as any).env?.secrets || {}),
    ...((process as any).secrets || {}),
    ...((process.env as any)?.secrets || {}),
  };

  const envOpenAiKeys = Object.keys(process.env || {}).filter((k) =>
    k.toUpperCase().includes("OPENAI")
  );
  const secretOpenAiKeys = Object.keys(envSecrets || {}).filter((k) =>
    k.toUpperCase().includes("OPENAI")
  );

  console.log("[/api/responses] debug", {
    rawSecretsLength: rawSecrets.length,
    envOpenAiKeys,
    secretOpenAiKeys,
  });

  const apiKey =
    process.env.OPENAI_API_KEY ||
    envSecrets.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY_2 ||
    envSecrets.OPENAI_API_KEY_2 ||
    "";
  const openai = new OpenAI({ apiKey });

  if (body.text?.format?.type === 'json_schema') {
    return await structuredResponse(openai, body);
  } else {
    return await textResponse(openai, body);
  }
}

async function structuredResponse(openai: OpenAI, body: any) {
  try {
    const response = await openai.responses.parse({
      ...(body as any),
      stream: false,
    });

    return NextResponse.json(response);
  } catch (err: any) {
    console.error('responses proxy error', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 }); 
  }
}

async function textResponse(openai: OpenAI, body: any) {
  try {
    const response = await openai.responses.create({
      ...(body as any),
      stream: false,
    });

    return NextResponse.json(response);
  } catch (err: any) {
    console.error('responses proxy error', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
  

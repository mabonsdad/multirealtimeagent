import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxy endpoint for the OpenAI Responses API
export async function POST(req: NextRequest) {
  const body = await req.json();

  const envOpenAiKeys = Object.keys(process.env || {}).filter((k) =>
    k.toUpperCase().includes("OPENAI")
  );

  console.log("[/api/responses] debug", { envOpenAiKeys });

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error("OPENAI_API_KEY missing for /api/responses", { envOpenAiKeys });
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY" },
      { status: 500 }
    );
  }

  const openai = new OpenAI({ apiKey });

  if (body.text?.format?.type === "json_schema") {
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
    console.error("[/api/responses] structured response error", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
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
    console.error("[/api/responses] text response error", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}

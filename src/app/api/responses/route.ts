import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY || "";

  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY" },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  const { model, input, ...rest } = body || {};
  if (!model || !input) {
    return NextResponse.json(
      { error: "Missing model or input" },
      { status: 400 },
    );
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input,
        ...rest,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Failed to call /responses", response.status, text);
      return NextResponse.json(
        { error: "Failed to call OpenAI /responses" },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("Error calling /responses", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

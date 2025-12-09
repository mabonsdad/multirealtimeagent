import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const envOpenAiKeys = Object.keys(process.env || {}).filter((k) =>
    k.toUpperCase().includes("OPENAI")
  );

  console.log("[/api/session] debug", {
    envOpenAiKeys,
  });

  const apiKey =
    process.env.OPENAI_API_KEY || "";

  if (!apiKey) {
    console.error("OPENAI_API_KEY is unfortunately not set; cannot create realtime session.", {
      envOpenAiKeys,
    });
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY", envOpenAiKeys },
      { status: 500 }
    );
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "realtime=v1",
        },
        body: JSON.stringify({
          model: "gpt-realtime-mini",
        }),
      }
    );

    if (!response.ok) {
      const errorPayload = await response.text();
      console.error(
        "Failed to create realtime session",
        response.status,
        response.statusText,
        errorPayload
      );
      return NextResponse.json(
        { error: "Failed to create realtime session" },
        { status: response.status }
      );
    }

    const data = await response.json();
    if (!data?.client_secret?.value) {
      console.error("Realtime session created without client_secret", data);
      return NextResponse.json(
        { error: "Realtime session response missing client_secret" },
        { status: 502 }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Error in /session:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

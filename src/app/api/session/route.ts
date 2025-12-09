import { NextResponse } from "next/server";

// Force this route to run in a Node.js runtime (not edge) so server env vars are available.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
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

  // Collect possible secret sources: parsed JSON string, and any injected objects.
  const envSecrets = {
    ...parsedSecrets,
    ...((process as any).env?.secrets || {}),
    ...((process as any).secrets || {}),
    ...((process.env as any)?.secrets || {}),
  };

  const presentEnvKeys = [
    ...Object.keys(process.env || {}),
    ...Object.keys(envSecrets || {}),
  ].filter((k) => k.toUpperCase().includes("OPENAI"));

  console.log("[/api/session] invoked", { presentEnvKeys });

  const apiKey =
    process.env.OPENAI_API_KEY_2 ||
    process.env.OPENAI_API_KEY ||
    envSecrets.OPENAI_API_KEY_2 ||
    envSecrets.OPENAI_API_KEY ||
    "";

  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set; cannot create realtime session.", {
      presentEnvKeys,
    });
    return NextResponse.json(
      { error: "Server is missing OPENAI_API_KEY", presentEnvKeys },
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

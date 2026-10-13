import { NextRequest, NextResponse } from "next/server";
import { BaseMarketNotConfiguredError, getBaseMarket, getDemoBaseMarket } from "@/lib/baseMarket";

const ALLOWED = new Set(["BTC", "ETH", "SOL"]);

export async function GET(req: NextRequest) {
  const underlying = (req.nextUrl.searchParams.get("underlying") ?? "BTC").toUpperCase();
  if (!ALLOWED.has(underlying)) {
    return NextResponse.json({ error: "unsupported underlying" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getBaseMarket(underlying), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (err) {
    if (err instanceof BaseMarketNotConfiguredError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }
    if (process.env.NODE_ENV === "production" || process.env.LEDGE_DISABLE_DEMO === "1") {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, {
        status: 502,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }
    return NextResponse.json(getDemoBaseMarket(underlying), {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { appOrigin } from "@/lib/api";

export async function POST(request: NextRequest) {
  const session = await getSession();
  session.destroy();
  return NextResponse.redirect(new URL("/", appOrigin(request)));
}

import { handle } from "hono/vercel";
import app from "server/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // Whisper needs ~2-3s per chunk, allow headroom

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);

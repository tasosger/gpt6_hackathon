import { handleApi } from "@/lib/server/api";
export const runtime = "nodejs";
export const maxDuration = 90;
export const GET = handleApi;
export const POST = handleApi;
export const PATCH = handleApi;
export const DELETE = handleApi;

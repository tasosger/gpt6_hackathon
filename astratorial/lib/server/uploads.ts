import type { CaptureAsset } from "@/lib/contracts";
import { supabaseAdmin } from "@/lib/supabase/server";
import { dbError } from "./errors";

export async function uploadConfiguration(uploadId: string, asset: CaptureAsset) {
  const result = await supabaseAdmin().storage.from("captures").createSignedUploadUrl(asset.path, { upsert: false });
  dbError(result.error);
  const base = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  if (base.hostname.endsWith(".supabase.co")) base.hostname = base.hostname.replace(".supabase.co", ".storage.supabase.co");
  return {
    uploadId, asset,
    // Signed TUS requests use /sign; the ordinary route expects a user JWT.
    endpoint: `${base.origin}/storage/v1/upload/resumable/sign`,
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "x-signature": result.data!.token },
    metadata: { bucketName: "captures", objectName: asset.path, contentType: asset.mimeType, cacheControl: "3600" },
    chunkSize: 6 * 1024 * 1024,
  };
}

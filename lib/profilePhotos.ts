import type { SupabaseClient } from "@supabase/supabase-js";

// Candidate profile photos are served ONLY to the candidate themselves (and
// admins), as short-lived signed URLs - never as a permanent public URL. The
// profile-pictures bucket was public, and since an employer can see candidate
// user ids, anyone could load /storage/v1/object/public/profile-pictures/<id>/avatar
// directly. Once the bucket is made private (see the RLS migration), only a
// signed URL minted here with the service role can load the image.
//
// Uploads always write to `${userId}/avatar` (components/ApplicantProfileForm.tsx).
// candidate_profiles.profile_picture_url is treated purely as a "has a photo"
// flag: the stored value may be a legacy public URL, and it is never returned
// to the browser as-is.

export const PROFILE_PICTURE_BUCKET = "profile-pictures";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export async function signedProfilePhotoUrl(
  adminClient: SupabaseClient,
  userId: string,
  storedValue: unknown
): Promise<string> {
  if (typeof storedValue !== "string" || !storedValue.trim()) return "";
  const { data, error } = await adminClient.storage
    .from(PROFILE_PICTURE_BUCKET)
    .createSignedUrl(`${userId}/avatar`, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.error("[profilePhotos] could not sign profile photo", { userId, error: error?.message });
    return "";
  }
  return data.signedUrl;
}

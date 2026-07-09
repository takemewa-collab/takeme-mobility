import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { createServiceClient } from "@/lib/supabase/service";

const ses = new SESClient({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Fallback is a branded address, not a personal inbox. NOTE: whatever address
// is used MUST be a verified identity in AWS SES or sends fail — set
// SES_FROM_EMAIL to a verified no-reply@takememobility.com in production.
const FROM_EMAIL = process.env.SES_FROM_EMAIL ?? 'no-reply@takememobility.com';

export async function sendEmailOTP(email: string): Promise<{ success: boolean; error?: string }> {
  try {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const supabase = createServiceClient();

    // Reuse the same store_otp RPC — the "phone" column accepts any text identifier
    const { data, error: rpcError } = await supabase.rpc('store_otp', {
      p_phone: email,
      p_code: code,
      p_ttl_seconds: 600,
    });

    if (rpcError) {
      console.error('[email-otp] store_otp RPC failed:', rpcError.message);
      return { success: false, error: 'Could not generate code.' };
    }

    const result = data as { success: boolean; error?: string };
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Send email via AWS SES
    await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: `Your TakeMe verification code: ${code}` },
        Body: {
          Html: {
            Data: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
                <div style="text-align: center; margin-bottom: 32px;">
                  <span style="font-size: 18px; font-weight: 600; color: #1D1D1F;">TakeMe</span>
                  <span style="font-size: 18px; font-weight: 300; color: #8E8E93; margin-left: 4px;">Mobility</span>
                </div>
                <div style="text-align: center;">
                  <p style="font-size: 15px; color: #6E6E73; margin-bottom: 24px;">Your verification code is:</p>
                  <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #1D1D1F; padding: 20px; background: #F5F5F7; border-radius: 12px; display: inline-block;">${code}</div>
                  <p style="font-size: 13px; color: #A1A1A6; margin-top: 24px;">This code expires in 10 minutes. Do not share it with anyone.</p>
                </div>
              </div>
            `,
          },
          Text: {
            Data: `Your TakeMe verification code: ${code}\n\nThis code expires in 10 minutes.`,
          },
        },
      },
    }));

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send email";
    console.error('[email-otp] Error:', msg);
    return { success: false, error: msg };
  }
}

export async function verifyEmailOTP(email: string, code: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServiceClient();

    const { data, error: rpcError } = await supabase.rpc('verify_otp', {
      p_phone: email,
      p_code: code,
    });

    if (rpcError) {
      console.error('[email-otp] verify_otp RPC failed:', rpcError.message);
      return { success: false, error: 'Verification failed.' };
    }

    return data as { success: boolean; error?: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed.";
    return { success: false, error: msg };
  }
}

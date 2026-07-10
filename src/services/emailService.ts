
import { supabase } from "@/integrations/supabase/client";

type EmailType = "order-confirmation" | "license-key" | "contact-form" | "contact-auto-reply";

interface SendEmailParams {
  to: string;
  from?: string;
  name: string;
  emailType: EmailType;
  orderDetails?: {
    amount?: number;
    productName?: string;
  };
  licenseKey?: string;
  inquiry?: string;
  replyTo?: string;
}

/**
 * Sends an email using the Supabase edge function
 */
export async function sendEmail(params: SendEmailParams) {
  try {
    const { data, error } = await supabase.functions.invoke("send-email", {
      body: params
    });

    if (error) {
      console.error("Error invoking send-email function:", error);
      throw error;
    }

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send email:", error);
    return {
      success: false,
      error: error.message || "Failed to send email"
    };
  }
}

/**
 * Sends an order confirmation email
 */
export async function sendOrderConfirmationEmail(customerEmail: string, customerName: string, amount?: number) {
  return sendEmail({
    to: customerEmail,
    name: customerName,
    emailType: "order-confirmation",
    orderDetails: {
      amount: amount || 29900,
      productName: "ArbiProSeller Lifetime License"
    }
  });
}

/**
 * Sends a license key email
 */
export async function sendLicenseKeyEmail(customerEmail: string, customerName: string, licenseKey: string) {
  return sendEmail({
    to: customerEmail,
    name: customerName,
    emailType: "license-key",
    licenseKey
  });
}

/**
 * Sends a contact form submission email to the site admin and auto-reply to user
 */
export async function sendContactFormEmail(adminEmail: string, customerName: string, customerEmail: string, inquiry: string) {
  // Send admin notification
  const adminResult = await sendEmail({
    to: adminEmail,
    from: "onboarding@resend.dev", // Use verified sender
    name: customerName,
    emailType: "contact-form",
    inquiry: inquiry,
    replyTo: customerEmail // Set reply-to to customer's email
  });

  // Send auto-reply to user
  const autoReplyResult = await sendEmail({
    to: customerEmail,
    from: "onboarding@resend.dev", // Use verified sender
    name: customerName,
    emailType: "contact-auto-reply"
  });

  // Return success only if both emails were sent successfully
  return {
    success: adminResult.success && autoReplyResult.success,
    adminResult,
    autoReplyResult,
    error: !adminResult.success ? adminResult.error : (!autoReplyResult.success ? autoReplyResult.error : null)
  };
}

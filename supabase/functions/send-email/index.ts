
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";

// Initialize Resend with API key from environment variables
const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// CORS headers to allow cross-origin requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": 
    "authorization, x-client-info, apikey, content-type",
};

// Email template types
type EmailType = "order-confirmation" | "license-key" | "contact-form" | "contact-auto-reply" | "price-alert-confirm" | "price-alert-fired";

interface EmailRequest {
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
  priceAlert?: {
    asin: string;
    marketplace?: string;
    targetPrice: number;
    currentPrice?: number;
    confirmUrl?: string;
  };
}

const handler = async (req: Request): Promise<Response> => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { to, from, name, emailType, orderDetails, licenseKey, inquiry, replyTo, priceAlert }: EmailRequest = await req.json();
    
    if (!to || !name || !emailType) {
      throw new Error("Missing required fields: to, name, or emailType");
    }

    console.log(`Sending ${emailType} email to ${to}`);
    
    // Default sender email - using Resend's onboarding email which is always verified
    const senderEmail = from || "onboarding@resend.dev";
    
    // Generate email content based on type
    let subject: string;
    let html: string;

    if (emailType === "order-confirmation") {
      subject = "Thank You for Your ArbiProSeller Purchase";
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6D28D9; margin-bottom: 24px;">Thank You for Your Purchase!</h1>
          <p>Hello ${name},</p>
          <p>We've received your payment of $${(orderDetails?.amount || 299) / 100} for ArbiProSeller.</p>
          <p>Your order is confirmed and your license key will be sent to this email address within 24 hours.</p>
          <div style="background-color: #F5F3FF; border: 1px solid #DDD6FE; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <h2 style="color: #5B21B6; margin-top: 0;">Order Summary:</h2>
            <p><strong>Product:</strong> ArbiProSeller Lifetime License</p>
            <p><strong>Amount Paid:</strong> $${(orderDetails?.amount || 299) / 100}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
          </div>
          <p>If you don't receive your license key within 24 hours, please check your spam folder or contact our support team.</p>
          <p>Thank you for choosing ArbiProSeller!</p>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            This is an automated message, please do not reply directly to this email.
          </p>
        </div>
      `;
    } else if (emailType === "license-key") {
      if (!licenseKey) {
        throw new Error("License key is required for license-key email type");
      }
      
      subject = "Your ArbiProSeller License Key";
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6D28D9; margin-bottom: 24px;">Your License Key is Ready!</h1>
          <p>Hello ${name},</p>
          <p>Thank you for purchasing ArbiProSeller. Your license key is now ready:</p>
          <div style="background-color: #F5F3FF; border: 1px solid #DDD6FE; border-radius: 8px; padding: 16px; margin: 24px 0; text-align: center;">
            <p style="font-family: monospace; font-size: 18px; font-weight: bold; color: #5B21B6; word-break: break-all;">${licenseKey}</p>
          </div>
          <h2 style="color: #5B21B6; margin-top: 32px;">How to Use Your License Key:</h2>
          <ol>
            <li>Download the ArbiProSeller software from <a href="https://arbiproseller.com/download" style="color: #6D28D9;">our download page</a></li>
            <li>Install the application on your computer</li>
            <li>Launch the application and enter your license key when prompted</li>
            <li>Enjoy unlimited access to all features!</li>
          </ol>
          <p>If you encounter any issues with your license key, please contact our support team.</p>
          <p>Thank you for choosing ArbiProSeller!</p>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            This is an automated message, please do not reply directly to this email.
          </p>
        </div>
      `;
    } else if (emailType === "contact-form") {
      if (!inquiry) {
        throw new Error("Inquiry is required for contact-form email type");
      }
      
      subject = `[Contact Form] New message from ${name}`;
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6D28D9; margin-bottom: 24px;">New Contact Form Submission</h1>
          <div style="background-color: #F5F3FF; border: 1px solid #DDD6FE; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${replyTo || 'Not provided'}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
            <p><strong>Message:</strong></p>
            <p style="white-space: pre-line; background-color: #ffffff; padding: 12px; border-radius: 4px;">${inquiry}</p>
          </div>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            Reply directly to this email to respond to ${name} at ${replyTo || 'their email address'}
          </p>
        </div>
      `;
    } else if (emailType === "contact-auto-reply") {
      subject = "Thanks for contacting us!";
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6D28D9; margin-bottom: 24px;">Thanks for contacting us!</h1>
          <p>Hi ${name},</p>
          <p>Thank you for reaching out! We'll get back to you as soon as possible.</p>
          <p>– The ArbiProSeller Team</p>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            This is an automated message, please do not reply directly to this email.
          </p>
        </div>
      `;
    } else if (emailType === "price-alert-confirm") {
      if (!priceAlert?.confirmUrl) {
        throw new Error("priceAlert.confirmUrl is required for price-alert-confirm email type");
      }
      subject = `Confirm your price alert for ${priceAlert.asin}`;
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6D28D9; margin-bottom: 24px;">Confirm your price alert</h1>
          <p>Hello,</p>
          <p>Someone (hopefully you) set up a price alert on InventorySprint for:</p>
          <div style="background-color: #F5F3FF; border: 1px solid #DDD6FE; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <p><strong>ASIN:</strong> ${priceAlert.asin} (${priceAlert.marketplace || "US"})</p>
            <p><strong>Notify when Amazon's price drops to:</strong> $${priceAlert.targetPrice.toFixed(2)}</p>
          </div>
          <p>Click below to confirm and activate this alert. If you don't confirm, no notifications will ever be sent.</p>
          <p style="text-align: center; margin: 32px 0;">
            <a href="${priceAlert.confirmUrl}" style="background-color: #6D28D9; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Confirm Price Alert</a>
          </p>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            If you didn't request this, you can safely ignore this email — the alert will never activate without confirmation.
          </p>
        </div>
      `;
    } else if (emailType === "price-alert-fired") {
      if (!priceAlert) {
        throw new Error("priceAlert is required for price-alert-fired email type");
      }
      subject = `Price alert: ${priceAlert.asin} hit your target of $${priceAlert.targetPrice.toFixed(2)}`;
      html = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #059669; margin-bottom: 24px;">Price target reached!</h1>
          <p>Hello,</p>
          <p>Amazon's price for the listing you're tracking has reached your target.</p>
          <div style="background-color: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 8px; padding: 16px; margin: 24px 0;">
            <p><strong>ASIN:</strong> ${priceAlert.asin} (${priceAlert.marketplace || "US"})</p>
            <p><strong>Your target:</strong> $${priceAlert.targetPrice.toFixed(2)}</p>
            <p><strong>Current Amazon price:</strong> $${(priceAlert.currentPrice ?? priceAlert.targetPrice).toFixed(2)}</p>
          </div>
          <p>This alert has now fired and will not send again. Set a new alert from the extension if you want to keep watching this listing.</p>
          <p style="margin-top: 32px; font-size: 12px; color: #6B7280; border-top: 1px solid #E5E7EB; padding-top: 16px;">
            This is an automated message, please do not reply directly to this email.
          </p>
        </div>
      `;
    } else {
      throw new Error(`Invalid email type: ${emailType}`);
    }

    // Prepare email options
    const emailOptions: any = {
      from: `ArbiProSeller <${senderEmail}>`,
      to: [to],
      subject: subject,
      html: html,
    };

    // Add reply-to for contact form emails
    if (emailType === "contact-form" && replyTo) {
      emailOptions.reply_to = [replyTo];
    }

    // Send the email using Resend
    const { data, error } = await resend.emails.send(emailOptions);

    if (error) {
      console.error("Email sending failed:", error);
      throw error;
    }

    console.log("Email sent successfully:", data);

    return new Response(JSON.stringify({ success: true, message: "Email sent successfully" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error("Error in send-email function:", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: (error as Error).message || "Failed to send email" 
      }),
      {
        status: 500,
        headers: { 
          "Content-Type": "application/json", 
          ...corsHeaders 
        },
      }
    );
  }
};

serve(handler);

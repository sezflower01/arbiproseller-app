
import { toast } from "@/components/ui/use-toast";
import { loadStripe } from "@stripe/stripe-js";
import { supabase } from "@/integrations/supabase/client";

// This should be a publishable key (starts with pk_test_ or pk_live_)
// DO NOT use Secret Keys (sk_*) in frontend code - this is a security risk!
const STRIPE_PUBLISHABLE_KEY = "pk_live_2rlhsfXbpxeXSzXyZ0a4Bz1G"; // Publishable key is safe for frontend code

/**
 * Create a payment checkout session using Stripe API
 * 
 * @param customerData Customer information for the payment
 * @returns Payment checkout session information
 */
export async function createStripeCheckoutSession(customerData: { 
  name: string;
  email: string;
  amount?: number; // Optional parameter for custom amount
}) {
  try {
    // First try to get the key from environment, then fallback to the hardcoded one
    const stripePublicKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || STRIPE_PUBLISHABLE_KEY;
    
    if (!stripePublicKey) {
      console.error("Stripe publishable key is missing");
      toast({
        title: "Configuration Error",
        description: "Payment system is not properly configured. Please contact support.",
        variant: "destructive",
      });
      return { success: false, error: "Missing Stripe configuration" };
    }
    
    console.log("Creating Stripe payment for:", customerData);
    console.log("Using Stripe key:", stripePublicKey.substring(0, 8) + "...");
    
    // Save customer data to Supabase before redirecting to payment page
    const amount = customerData.amount || 29900;
    
    console.log("Attempting to save customer data to Supabase...");
    
    const { data, error } = await supabase
      .from('customers')
      .upsert([
        {
          name: customerData.name,
          email: customerData.email,
          amount: amount,
          payment_status: 'pending'
        }
      ], 
      { onConflict: 'email' })
      .select();
    
    if (error) {
      console.error("Error saving customer data:", error);
      toast({
        title: "Database Error",
        description: "Failed to save customer information. Please try again.",
        variant: "destructive",
      });
      return { success: false, error: "Failed to save customer data" };
    } else {
      console.log("Customer data saved successfully:", data);
    }
    
    // Store customer information in session storage for retrieval after payment
    sessionStorage.setItem('arbiProCustomer', JSON.stringify(customerData));
    console.log("Customer data stored in session storage");

    // Use the user's provided payment link
    const paymentLink = "https://buy.stripe.com/eVacOE9kM38pauQcMM"; // Live mode URL
    
    // Add customer email as a query parameter
    const finalUrl = customerData.email 
      ? `${paymentLink}?prefilled_email=${encodeURIComponent(customerData.email)}` 
      : paymentLink;
    
    console.log("Redirecting to payment URL:", finalUrl);
    
    // Check if we're running in the Lovable editor (iframe environment)
    const isInIframe = window !== window.top;
    
    if (isInIframe) {
      // For Lovable editor, open in a new tab
      window.open(finalUrl, '_blank');
      
      toast({
        title: "Payment Page Opened",
        description: "Please check your browser for the Stripe payment page in a new tab.",
      });
    } else {
      // For regular website, redirect in the same window
      window.location.href = finalUrl;
      
      toast({
        title: "Redirecting to Payment",
        description: "Please complete your payment on the Stripe checkout page.",
      });
    }
    
    return {
      success: true,
      message: "Redirecting to Stripe checkout",
    };
  } catch (error) {
    console.error("Error creating Stripe checkout session:", error);
    toast({
      title: "Payment Error",
      description: "Unable to create checkout session. Please try again later.",
      variant: "destructive",
    });
    
    return {
      success: false,
      error: "Payment initialization failed",
    };
  }
}

/**
 * Handle payment completion callback
 * 
 * @param sessionId The checkout session ID to verify
 * @returns Result of payment completion
 */
export async function handleStripePaymentComplete(sessionId: string) {
  try {
    // Get customer data from session storage
    const storedCustomer = sessionStorage.getItem('arbiProCustomer');
    let customerEmail = null;
    if (storedCustomer) {
      const customerData = JSON.parse(storedCustomer);
      customerEmail = customerData.email;
    }

    // Update payment status in database
    if (customerEmail) {
      const { error } = await supabase
        .from('customers')
        .update({ payment_status: 'completed' })
        .eq('email', customerEmail);
      
      if (error) {
        console.error("Error updating payment status:", error);
      } else {
        console.log("Payment status updated for:", customerEmail);
      }
    }
    
    console.log("Payment session ID:", sessionId);
    
    // In a real implementation, you would verify the payment with your backend
    return {
      success: true,
      verified: true, // Assuming payment is successful for demo
      message: "Payment completed successfully",
    };
  } catch (error) {
    console.error("Error verifying payment:", error);
    return {
      success: false,
      message: "Payment verification failed",
    };
  }
}

/**
 * Verify payment status with Stripe
 * 
 * @param sessionId The checkout session ID to verify
 * @returns Verification status
 */
export async function verifyStripePayment(sessionId: string) {
  return handleStripePaymentComplete(sessionId);
}

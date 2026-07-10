import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { toast } from "@/components/ui/use-toast";
import PaymentForm from "@/components/payment/PaymentForm";
import PaymentInstructions from "@/components/payment/PaymentInstructions";
import PaymentSuccess from "@/components/payment/PaymentSuccess";
import PaymentAlert from "@/components/payment/PaymentAlert";
import { supabase } from "@/integrations/supabase/client";
import { sendOrderConfirmationEmail } from "@/services/emailService";
import { useLanguage } from "@/contexts/LanguageContext";

const BuyLicense = () => {
  const { t } = useLanguage();
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'idle' | 'success' | 'canceled'>('idle');
  const location = useLocation();
  const navigate = useNavigate();
  
  useEffect(() => {
    // Check if coming back from Stripe payment
    const searchParams = new URLSearchParams(location.search);
    
    // Check for Stripe's various success indicators in URL parameters
    if (searchParams.get('success') === 'true' || 
        searchParams.has('payment_intent') || 
        searchParams.has('payment_intent_client_secret') || 
        searchParams.has('redirect_status') ||
        location.hash === '#success') {
      handlePaymentSuccess();
    } 
    // Check for cancellation indicators
    else if (searchParams.get('success') === 'false' || 
             searchParams.get('canceled') === 'true' || 
             location.hash === '#cancel') {
      setPaymentStatus('canceled');
      toast({
        title: t('payment.canceled.title'),
        description: t('payment.canceled.description'),
      });
      
      // Clean up URL
      navigate('/buy-license', { replace: true });
    }
    
    // Check for any messages stored in sessionStorage
    // This is useful for handling returns from payment page in new tab (Lovable editor scenario)
    const paymentMessage = sessionStorage.getItem('arbiProPaymentMessage');
    if (paymentMessage) {
      if (paymentMessage === 'success') {
        handlePaymentSuccess();
      } else if (paymentMessage === 'canceled') {
        setPaymentStatus('canceled');
        toast({
          title: t('payment.canceled.title'),
          description: t('payment.canceled.description'),
        });
      }
      // Clear the message after processing
      sessionStorage.removeItem('arbiProPaymentMessage');
    }
    
    // Log all URL parameters for debugging
    console.log("Current location:", location);
    console.log("Search params:", Object.fromEntries(searchParams.entries()));
    console.log("Hash:", location.hash);
  }, [location, navigate]);
  
  const handlePaymentSuccess = async () => {
    try {
      console.log("Processing successful payment");
      setPaymentStatus('success');
      
      const storedCustomer = sessionStorage.getItem('arbiProCustomer');
      let customerName = 'customer';
      let customerEmail = null;
      let amount = 29900;
      
      if (storedCustomer) {
        const customer = JSON.parse(storedCustomer);
        customerName = customer.name || customerName;
        customerEmail = customer.email;
        amount = customer.amount || amount;
        
        // Update customer payment status in Supabase
        if (customerEmail) {
          const licenseKey = `ARBI-${customerEmail.substring(0, 4).toUpperCase()}-${Date.now().toString(36)}`;
          
          const { error } = await supabase
            .from('customers')
            .update({ 
              payment_status: 'completed',
              // In a real implementation, you would generate a license key here
              // or call a backend function to generate one
              license_key: licenseKey
            })
            .eq('email', customerEmail);
          
          if (error) {
            console.error("Error updating payment status:", error);
          } else {
            console.log("Payment completed and license key generated for:", customerEmail);
            
            // Send order confirmation email
            if (customerEmail) {
              console.log("Sending order confirmation email to:", customerEmail);
              const emailResult = await sendOrderConfirmationEmail(customerEmail, customerName, amount);
              
              if (emailResult.success) {
                console.log("Order confirmation email sent successfully");
              } else {
                console.error("Failed to send order confirmation email:", emailResult.error);
              }
            }
          }
        }
      }
      
      toast({
        title: t('payment.success.title'),
        description: t('payment.success.description'),
      });
      
      // Clean up URL
      navigate('/buy-license', { replace: true });
    } catch (error) {
      console.error("Payment verification error:", error);
      toast({
        title: t('payment.error.title'),
        description: t('payment.error.verification'),
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Buy License | ArbiProSeller</title>
        <meta name="description" content="Purchase your ArbiProSeller license and unlock the full Amazon arbitrage and repricing suite." />
        <link rel="canonical" href="https://arbiproseller.com/buy-license" />
        <meta property="og:title" content="Buy License | ArbiProSeller" />
        <meta property="og:description" content="Purchase your ArbiProSeller license." />
        <meta property="og:url" content="https://arbiproseller.com/buy-license" />
        <meta name="twitter:title" content="Buy License | ArbiProSeller" />
        <meta name="twitter:description" content="Purchase your ArbiProSeller license." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4">
          {paymentStatus === 'success' ? (
            <PaymentSuccess />
          ) : (
            <div className="max-w-3xl mx-auto">
              <h1 className="text-3xl md:text-4xl font-bold mb-6 gradient-text text-center">
                {t('payment.page.title')}
              </h1>
              <p className="text-lg text-gray-600 mb-10 text-center">
                {t('payment.page.subtitle')}
              </p>

              <PaymentAlert status={paymentStatus} />
              <PaymentForm onProcessingStateChange={setIsProcessing} />
              <PaymentInstructions />
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default BuyLicense;

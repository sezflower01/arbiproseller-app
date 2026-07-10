
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, CreditCard, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/use-toast";
import { createStripeCheckoutSession } from "@/services/stripePayment";
import { useLanguage } from "@/contexts/LanguageContext";

const PaymentForm = ({ onProcessingStateChange }: { onProcessingStateChange: (isProcessing: boolean) => void }) => {
  const { t } = useLanguage();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  
  // Create form schema with translated error messages
  const formSchema = z.object({
    name: z.string().min(2, {
      message: t('payment.form.name_error'),
    }),
    email: z.string().email({
      message: t('payment.form.email_error'),
    }).refine((email) => email.toLowerCase().endsWith('@gmail.com'), {
      message: t('payment.form.gmail_required')
    }),
  });
  
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    if (isSubmitting) return; // Prevent double-submissions
    
    setIsSubmitting(true);
    setPaymentError(null);
    onProcessingStateChange(true);
    
    try {
      // Show processing toast
      toast({
        title: t('payment.processing.title'),
        description: t('payment.processing.description'),
      });

      console.log("Submitting payment form with values:", values);
      
      const customerData = {
        name: values.name,
        email: values.email,
        amount: 29900
      };
      
      // Create checkout session using the service
      const result = await createStripeCheckoutSession(customerData);
      
      if (!result.success) {
        console.error("Payment creation failed:", result.error);
        throw new Error(result.error || "Failed to create payment session");
      }
      
      // The redirect happens automatically in the createStripeCheckoutSession function
      
    } catch (error) {
      console.error("Payment error:", error);
      
      // Set a more descriptive error message based on the error
      if (error.message && error.message.includes("API key")) {
        setPaymentError(t('payment.error.api_config'));
      } else {
        setPaymentError(t('payment.error.general'));
      }
      
      toast({
        title: t('payment.error.title'),
        description: t('payment.error.description'),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
      onProcessingStateChange(false);
    }
  };

  return (
    <>
      <Card className="border-2 border-purple-200 shadow-lg mb-8">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl font-bold">{t('payment.card.title')}</CardTitle>
              <CardDescription>
                {t('payment.card.description')}
              </CardDescription>
            </div>
            <div className="bg-purple-100 text-purple-700 p-3 rounded-full">
              <CreditCard size={24} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {paymentError && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-600 flex items-start">
              <AlertCircle className="h-5 w-5 mr-2 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">{t('payment.error.title')}</p>
                <p className="text-sm">{paymentError}</p>
              </div>
            </div>
          )}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('payment.form.full_name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('payment.form.name_placeholder')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('payment.form.gmail_address')}</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder={t('payment.form.email_placeholder')} 
                        type="email"
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button 
                type="submit" 
                className="w-full py-6" 
                size="lg" 
                disabled={isSubmitting}
              >
                {isSubmitting ? t('payment.form.processing') : (
                  <span className="flex items-center gap-2">
                    {t('payment.form.continue_button')} <ArrowRight size={18} />
                  </span>
                )}
              </Button>
              <div className="text-center text-sm text-gray-500 mt-2">
                {t('payment.form.secure_note')}
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </>
  );
};

export default PaymentForm;

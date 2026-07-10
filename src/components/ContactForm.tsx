
import React, { useState } from 'react';
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { sendContactFormEmail } from "@/services/emailService";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const formSchema = z.object({
  firstName: z.string().min(2, "First name must be at least 2 characters"),
  lastName: z.string().min(2, "Last name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  inquiry: z.string().min(10, "Inquiry must be at least 10 characters"),
});

const ContactForm = () => {
  const { toast } = useToast();
  const { t, language, isLoading } = useLanguage();
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      inquiry: "",
    },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setSubmitStatus('loading');
    
    try {
      // Change this to your verified email in Resend
      const adminEmail = "onboarding@resend.dev"; // This is always verified with Resend
      
      const result = await sendContactFormEmail(
        adminEmail,
        `${values.firstName} ${values.lastName}`,
        values.email,
        values.inquiry
      );

      if (!result.success) {
        throw new Error(result.error || "Failed to send message");
      }

      toast({
        title: t('contact.success_title'),
        description: t('contact.success_description'),
      });
      
      setSubmitStatus('success');
      form.reset();
    } catch (error) {
      console.error("Contact form submission error:", error);
      toast({
        variant: "destructive",
        title: t('contact.error_title'),
        description: t('contact.error_description'),
      });
      setSubmitStatus('error');
    }
  };

  // Fallback translations while loading or if translation fails
  const getText = (key: string, fallback: string) => {
    if (isLoading) return fallback;
    const translation = t(key);
    return translation === key ? fallback : translation;
  };

  const getPlaceholder = (key: string, fallbackEn: string, fallbackEs: string) => {
    if (isLoading) return language === 'es' ? fallbackEs : fallbackEn;
    const translation = t(key);
    if (translation === key) {
      return language === 'es' ? fallbackEs : fallbackEn;
    }
    return translation;
  };

  return (
    <section className="py-16 bg-gray-50" id="contact">
      <div className="container mx-auto px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-bold mb-8 text-center bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">
            {getText('contact.title', language === 'es' ? 'Contacto' : 'Contact')}
          </h2>
          
          {submitStatus === 'success' && (
            <Alert className="mb-6 bg-green-50 border-green-200">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <AlertDescription className="text-green-800">
                {getText('contact.success_description', language === 'es' ? 'Gracias por contactarnos. Te responderemos pronto.' : 'Thank you for contacting us. We will respond soon.')}
              </AlertDescription>
            </Alert>
          )}
          
          {submitStatus === 'error' && (
            <Alert className="mb-6 bg-red-50 border-red-200">
              <AlertCircle className="h-5 w-5 text-red-600" />
              <AlertDescription className="text-red-800">
                {getText('contact.error_description', language === 'es' ? 'Hubo un problema al enviar tu mensaje. Por favor intenta de nuevo.' : 'There was a problem sending your message. Please try again.')}
              </AlertDescription>
            </Alert>
          )}
          
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{getText('contact.first_name', language === 'es' ? 'Nombre' : 'First Name')}</FormLabel>
                      <FormControl>
                        <Input placeholder={getPlaceholder('contact.first_name_placeholder', 'John', 'Juan')} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{getText('contact.last_name', language === 'es' ? 'Apellido' : 'Last Name')}</FormLabel>
                      <FormControl>
                        <Input placeholder={getPlaceholder('contact.last_name_placeholder', 'Doe', 'Pérez')} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{getText('contact.email', language === 'es' ? 'Correo Electrónico' : 'Email')}</FormLabel>
                    <FormControl>
                      <Input placeholder={getPlaceholder('contact.email_placeholder', 'john.doe@example.com', 'juan.perez@ejemplo.com')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="inquiry"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{getText('contact.inquiry', language === 'es' ? 'Consulta' : 'Inquiry')}</FormLabel>
                    <FormControl>
                      <Textarea 
                        placeholder={getPlaceholder('contact.inquiry_placeholder', 'How can we help you?', '¿Cómo podemos ayudarte?')}
                        className="min-h-[120px]" 
                        {...field} 
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button 
                type="submit" 
                className="w-full" 
                size="lg" 
                disabled={submitStatus === 'loading'}
              >
                {submitStatus === 'loading' 
                  ? getText('contact.sending', language === 'es' ? 'Enviando...' : 'Sending...') 
                  : getText('contact.submit', language === 'es' ? 'Enviar' : 'Submit')
                }
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </section>
  );
};

export default ContactForm;

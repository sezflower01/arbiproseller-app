
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface RegisterParams {
  email: string;
  username: string;
  licensekey?: string;
}

export const useRegisterWithHashedPassword = () => {
  const { toast } = useToast();
  
  const registerUser = async ({ email, username, licensekey }: RegisterParams) => {
    const functionUrl = `https://mstibdszibcheodvnprm.supabase.co/functions/v1/register-with-hashed-password`;
    const supabaseAnonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zdGliZHN6aWJjaGVvZHZucHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM4MTA3NTUsImV4cCI6MjA1OTM4Njc1NX0.akgxF2XOOlNk8OTECcLeOSP1DWqRY89dBDW8GkE2pgc";
    
    console.log(`Attempting to invoke Supabase function (using fetch) at URL: ${functionUrl} with params:`, { email, username, licensekey_present: !!licensekey });

    try {
      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseAnonKey,
          'Authorization': `Bearer ${supabaseAnonKey}`
        },
        body: JSON.stringify({
          email,
          username,
          licensekey
        }),
      });

      console.log('Raw response status:', response.status);
      console.log('Raw response status text:', response.statusText);
      
      const responseBody = await response.json().catch(e => {
        console.error("Failed to parse response JSON", e);
        return { error: "Failed to parse server response." };
      });
      console.log('Raw response body:', responseBody);

      if (!response.ok) {
        let errorMessage = `Server responded with ${response.status}: ${response.statusText}.`;
        if (responseBody && responseBody.error) {
          errorMessage += ` Details: ${typeof responseBody.error === 'string' ? responseBody.error : JSON.stringify(responseBody.error)}`;
        } else if (response.status === 404) {
          errorMessage = "Error: 404. The registration service was not found. Please contact support.";
        } else if (response.status === 0 || response.statusText.toLowerCase().includes("failed to fetch") || response.statusText.toLowerCase().includes("networkerror")) {
          errorMessage = "A network error occurred. Please check your internet connection.";
        }
        
        console.error(`Error invoking function ${functionUrl}: Status ${response.status}`, responseBody);
        toast({
          title: "Registration failed",
          description: errorMessage,
          variant: "destructive",
        });
        return { success: false, error: responseBody?.error || errorMessage };
      }
      
      console.log(`Function '${functionUrl}' invoked successfully via fetch, data:`, responseBody);
      toast({
        title: "Registration successful",
        description: responseBody?.message || "Your account has been created successfully.",
      });
      
      return { success: true, user: responseBody?.user };

    } catch (error: any) {
      console.error('Catch block: Unexpected error during client-side registration logic (fetch):', error);
      let clientErrorMessage = "An unexpected error occurred on the client. Please try again.";
      if (error.message && (error.message.toLowerCase().includes("failed to fetch") || error.message.toLowerCase().includes("networkerror"))) {
        clientErrorMessage = "A network error occurred while making the request. Please check your connection.";
      } else if (error.message) {
        clientErrorMessage = `Client-side error: ${error.message}`;
      }
      toast({
        title: "Registration failed",
        description: clientErrorMessage,
        variant: "destructive",
      });
      return { success: false, error };
    }
  };
  
  return { registerUser };
};

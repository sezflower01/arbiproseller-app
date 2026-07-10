import { useEffect } from 'react';
import { toast } from 'sonner';
import { reportError } from '@/services/errorReportService';

/**
 * Intercepts toast.error calls and console.error to auto-report errors to admins.
 */
// User-facing validation messages that should NOT be reported as errors
const IGNORED_TOAST_PATTERNS = [
  /select.*record/i,
  /highlight.*record/i,
  /please select/i,
  /no.*selected/i,
  /choose.*first/i,
  /field.*required/i,
  /enter.*valid/i,
  /fill in/i,
];

const isValidationMessage = (msg: string): boolean =>
  IGNORED_TOAST_PATTERNS.some((re) => re.test(msg));

const GlobalErrorInterceptor = () => {
  useEffect(() => {
    // 1. Intercept toast.error
    const originalToastError = toast.error;
    toast.error = (message: any, ...args: any[]) => {
      const msg = typeof message === 'string' ? message : String(message);
      if (!isValidationMessage(msg)) {
        const stack = new Error().stack?.split('\n').slice(2, 6).join('\n') || '';
        const context = `toast.error on ${window.location.pathname}\n\nStack:\n${stack}`;
        reportError(msg.slice(0, 500), context.slice(0, 1000));
      }
      return (originalToastError as any)(message, ...args);
    };

    // 2. Intercept unhandled promise rejections
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason?.message || String(event.reason);
      const stack = event.reason?.stack?.split('\n').slice(0, 6).join('\n') || '';
      const context = `unhandled_rejection on ${window.location.pathname}\n\nStack:\n${stack}`;
      reportError(msg.slice(0, 500), context.slice(0, 1000));
    };
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      toast.error = originalToastError;
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  return null;
};

export default GlobalErrorInterceptor;

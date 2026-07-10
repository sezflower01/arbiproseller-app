/**
 * Translates technical error messages into human-readable language.
 */
export function translateErrorMessage(errorMessage: string | null): string {
  if (!errorMessage) return "";
  
  const msg = errorMessage.toLowerCase();

  // Edge Function / network errors
  if (msg.includes("edge function returned a non-2xx status code")) {
    return "Amazon rejected the price update. This usually means the price conflicts with Amazon's pricing rules or your account limits.";
  }
  if (msg.includes("edge function") && msg.includes("timed out")) {
    return "The request to Amazon took too long and timed out. It will be retried automatically.";
  }
  if (msg.includes("functionsrelayhttperror") || msg.includes("relay error")) {
    return "Temporary server communication issue. The system will retry automatically.";
  }
  if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("network error")) {
    return "Network connection issue. Check your internet connection — the system will retry.";
  }

  // Amazon SP-API specific errors
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("throttl") || msg.includes("too many requests")) {
    return "Amazon is temporarily limiting requests. The system will wait and retry automatically.";
  }
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("token expired") || msg.includes("invalid_grant")) {
    return "Your Amazon connection has expired. Please re-authorize your Amazon account in Settings.";
  }
  if (msg.includes("403") || msg.includes("forbidden") || msg.includes("access denied")) {
    return "Amazon denied access. Your Amazon authorization may need to be refreshed in Settings.";
  }
  if (msg.includes("404") || msg.includes("not found")) {
    return "This listing was not found on Amazon. It may have been removed or the ASIN/SKU is incorrect.";
  }
  if (msg.includes("500") || msg.includes("internal server error") || msg.includes("internal_failure")) {
    return "Amazon's servers encountered an error. This is on Amazon's side — it will be retried.";
  }
  if (msg.includes("503") || msg.includes("service unavailable")) {
    return "Amazon's service is temporarily unavailable. The system will retry shortly.";
  }

  // Pricing-specific errors
  if (msg.includes("price_below_effective_floor") || msg.includes("effective floor") || msg.includes("profit_guard")) {
    return "Price blocked by Profit Guard — the calculated price would result in too little profit. Adjust your cost or min price.";
  }
  if (msg.includes("fair pricing") || msg.includes("pricing policy") || msg.includes("price too high") || msg.includes("potential pricing error")) {
    return "Amazon flagged this price as potentially violating their Fair Pricing Policy. Consider resetting to a safe price.";
  }
  if (msg.includes("min") && msg.includes("max") && (msg.includes("mismatch") || msg.includes("conflict") || msg.includes("greater"))) {
    return "Min/Max price conflict — your minimum price is higher than your maximum. Please fix your price bounds.";
  }
  if (msg.includes("suppressed") || msg.includes("inactive listing") || msg.includes("listing is not active")) {
    return "This listing is suppressed or inactive on Amazon. Check Listing Health in Seller Central.";
  }

  // Feed-specific errors
  if (msg.includes("feed") && msg.includes("fail")) {
    return "The bulk price update feed had errors. Some SKUs may not have been updated — check the feed results.";
  }
  if (msg.includes("feed") && msg.includes("cancel")) {
    return "The bulk price update was cancelled. Prices were not changed.";
  }

  // Auth / connection errors
  if (msg.includes("lwa") || msg.includes("login with amazon")) {
    return "Amazon login authorization failed. Please reconnect your Amazon account in Settings.";
  }
  if (msg.includes("refresh token") && (msg.includes("invalid") || msg.includes("expired"))) {
    return "Your Amazon session has expired. Please re-authorize your Amazon account in Settings.";
  }

  // Database errors (shouldn't normally show to users, but just in case)
  if (msg.includes("unique constraint") || msg.includes("duplicate key")) {
    return "A duplicate record was detected. This is usually harmless — the system handled it.";
  }
  if (msg.includes("foreign key") || msg.includes("violates")) {
    return "A data consistency issue occurred. Please try again or contact support.";
  }

  // Timeout
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("deadline exceeded")) {
    return "The operation took too long and timed out. It will be retried automatically.";
  }

  // Generic catch-all: if it looks very technical, simplify it
  if (msg.includes("error:") || msg.includes("exception") || msg.includes("stack trace") || msg.includes("at ")) {
    return "An unexpected error occurred while updating the price. The system will retry if possible.";
  }

  // If nothing matched, return the original (it might already be readable)
  return errorMessage;
}

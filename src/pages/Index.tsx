
import React from "react";
import { Navigate } from "react-router-dom";
import IndexPageLayout from "@/components/layout/IndexPageLayout";
import IndexPageSections from "@/components/layout/IndexPageSections";
import { useScrollTracking } from "@/hooks/use-scroll-tracking";
import { useAuth } from "@/contexts/AuthContext";

const Index = () => {
  useScrollTracking();
  const { user } = useAuth();

  if (user) {
    return <Navigate to="/tools" replace />;
  }

  return (
    <IndexPageLayout
      metaTitle="Amazon Arbitrage & Repricer Software | ArbiProSeller"
      metaDescription="Find deals, track suppliers, and auto-price Amazon FBA listings. Free 60-day trial — no credit card."
    >
      <IndexPageSections />
    </IndexPageLayout>
  );
};

export default Index;

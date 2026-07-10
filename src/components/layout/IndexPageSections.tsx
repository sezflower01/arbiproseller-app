
import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";
import Hero from "@/components/Hero";
import AiBanner from "@/components/AiBanner";
import ProductLibraryBanner from "@/components/ProductLibraryBanner";
import SalesDashboardBanner from "@/components/SalesDashboardBanner";

import SmartPricingSection from "@/components/SmartPricingSection";
import SafetySection from "@/components/SafetySection";
import ComparisonSection from "@/components/ComparisonSection";
import FinalCTA from "@/components/FinalCTA";
import ScrollIndicator from "@/components/ScrollIndicator";


const IndexPageSections = () => {
  const location = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const section = params.get('section');
    if (section) {
      setTimeout(() => {
        const element = document.getElementById(section);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
    }
  }, [location.search]);

  return (
    <>
      <Hero />
      <AiBanner />
      <ProductLibraryBanner />
      <SalesDashboardBanner />
      <SmartPricingSection />
      <SafetySection />
      <ComparisonSection />
      <FinalCTA />
      <ScrollIndicator />
    </>
  );
};

export default IndexPageSections;

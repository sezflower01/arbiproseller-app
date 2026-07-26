
import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";
import Hero from "@/components/Hero";
import SprintModulesBanner from "@/components/SprintModulesBanner";
import ProductLibraryBanner from "@/components/ProductLibraryBanner";
import ChromeExtensionBanner from "@/components/ChromeExtensionBanner";
import SalesDashboardBanner from "@/components/SalesDashboardBanner";
import MobileAppBanner from "@/components/MobileAppBanner";

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
      <SprintModulesBanner />
      <ProductLibraryBanner />
      <ChromeExtensionBanner />
      <SalesDashboardBanner />
      <MobileAppBanner />
      <SmartPricingSection />
      <SafetySection />
      <ComparisonSection />
      <FinalCTA />
      <ScrollIndicator />
    </>
  );
};

export default IndexPageSections;

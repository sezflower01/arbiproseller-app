
import React from "react";
import Navbar from "@/components/Navbar";
import DownloadHero from "@/components/DownloadHero";
import DownloadSection from "@/components/DownloadSection";
import InstructionSection from "@/components/InstructionSection";
import Footer from "@/components/Footer";
import { Toaster } from "@/components/ui/toaster";
import { Helmet } from "react-helmet-async";
import WindowsNotice from "@/components/WindowsNotice";

const Download = () => {
  console.log("Download page rendered");
  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Download Online Arbitrage Software | ArbiProSeller Free Trial</title>
        <meta name="description" content="Download the #1 online arbitrage software for Amazon FBA sellers. Start your free 30-day trial of ArbiProSeller OA database today - no credit card required!" />
        <link rel="canonical" href="https://arbiproseller.com/download" />
        {/* We could also add SoftwareApplication structured data here if it's more specific than the general one on the homepage */}
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-16">
        <DownloadHero />
        <WindowsNotice />
        <DownloadSection />
        <InstructionSection />
      </main>
      <Footer />
      <Toaster />
    </div>
  );
};

export default Download;

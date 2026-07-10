import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import OperatorQueueCard from "@/components/monitor/OperatorQueueCard";
import ActionCenterCard from "@/components/monitor/ActionCenterCard";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function OperatorQueuePage() {
  return (
    <>
      <Helmet>
        <title>Action queue — ArbiPro Seller</title>
        <meta
          name="description"
          content="The actions worth your time today, ranked by impact."
        />
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-[hsl(222,84%,4.9%)] text-white">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold">Action queue</h1>
              <p className="text-muted-foreground mt-1">
                The actions worth your time today, ranked by impact.
              </p>
            </div>
            <Button variant="outline" asChild size="sm">
              <Link to="/tools/repricer/monitor">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back to Monitor
              </Link>
            </Button>
          </div>
          <ActionCenterCard />
          <OperatorQueueCard limit={50} title="All open actions" />
        </main>
        <Footer />
      </div>
    </>
  );
}

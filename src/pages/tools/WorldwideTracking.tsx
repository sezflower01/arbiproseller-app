import { Helmet } from "react-helmet-async";
import { useState } from "react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Package, ExternalLink, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const CARRIERS = [
  { value: "auto", label: "Auto-detect Carrier", url: null },
  // North America
  { value: "usps", label: "USPS (USA)", url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=" },
  { value: "ups", label: "UPS (Worldwide)", url: "https://www.ups.com/track?tracknum=" },
  { value: "fedex", label: "FedEx (Worldwide)", url: "https://www.fedex.com/fedextrack/?trknbr=" },
  { value: "canadapost", label: "Canada Post", url: "https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=" },
  { value: "amazon", label: "Amazon Logistics", url: "https://track.amazon.com/tracking/" },
  { value: "ontrac", label: "OnTrac (USA)", url: "https://www.ontrac.com/tracking/?number=" },
  { value: "lasership", label: "LaserShip (USA)", url: "https://www.lasership.com/track/" },
  // US Freight Carriers
  { value: "odfl", label: "Old Dominion Freight (ODFL)", url: "https://www.odfl.com/Trace/standardResult.faces?pro=" },
  { value: "xpo", label: "XPO Logistics", url: "https://www.xpo.com/en-US/tracking?proNumber=" },
  { value: "estes", label: "Estes Express Lines", url: "https://www.estes-express.com/myestes/shipment-tracking?type=PRO&query=" },
  { value: "abf", label: "ABF Freight", url: "https://arcb.com/tools/tracking.html#/" },
  { value: "yrc", label: "Yellow Freight (YRC)", url: "https://my.yrc.com/tools/track/shipments?referenceNumbers=" },
  { value: "rl", label: "R+L Carriers", url: "https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=" },
  { value: "saia", label: "Saia LTL Freight", url: "https://www.saia.com/track?query=" },
  { value: "holland", label: "Holland Freight", url: "https://www.hollandregional.com/Tracking?pro=" },
  { value: "central", label: "Central Transport", url: "https://www.centraltransportint.com/track/?searchType=PRO&pro=" },
  { value: "dayton", label: "Dayton Freight", url: "https://www.daytonfreight.com/content/tracking/tracking?t=" },
  { value: "tforce", label: "TForce Freight", url: "https://www.tforcefreight.com/ltl/apps/Tracking?pro=" },
  { value: "fedexfreight", label: "FedEx Freight", url: "https://www.fedex.com/fedextrack/?action=track&trackingnumber=" },
  { value: "sefl", label: "Southeastern Freight Lines", url: "https://www.sefl.com/webconnect/tracking-quotes/track-by-pro.html?pro=" },
  { value: "averitt", label: "Averitt Express", url: "https://www.averittexpress.com/shipment-tracking?proNumber=" },
  { value: "ward", label: "Ward Trucking", url: "https://www.wardtrucking.com/track/search?proNumber=" },
  { value: "pitohio", label: "Pitt Ohio", url: "https://www.pittohio.com/track-shipment?proNumber=" },
  // Europe
  { value: "dhl", label: "DHL Express (Worldwide)", url: "https://www.dhl.com/en/express/tracking.html?AWB=" },
  { value: "royalmail", label: "Royal Mail (UK)", url: "https://www.royalmail.com/track-your-item#/" },
  { value: "laposte", label: "La Poste (France)", url: "https://www.laposte.fr/outils/suivre-vos-envois?code=" },
  { value: "dpd", label: "DPD (Europe)", url: "https://tracking.dpd.de/status/en_US/parcel/" },
  { value: "evri", label: "Evri/Hermes (UK)", url: "https://www.evri.com/track-a-parcel/" },
  { value: "postnl", label: "PostNL (Netherlands)", url: "https://jouw.postnl.nl/track-and-trace/" },
  { value: "parcelforce", label: "Parcelforce (UK)", url: "https://www.parcelforce.com/track-trace?trackNumber=" },
  { value: "gls", label: "GLS (Europe)", url: "https://gls-group.eu/GROUP/en/parcel-tracking?match=" },
  { value: "deutschepost", label: "Deutsche Post (Germany)", url: "https://www.deutschepost.de/sendung/simpleQuery.html?form.sendungsnummer=" },
  { value: "correos", label: "Correos (Spain)", url: "https://www.correos.es/es/en/tools/track?tracking-number=" },
  { value: "posteitaliane", label: "Poste Italiane (Italy)", url: "https://www.poste.it/cerca/index.html#/risultati-spedizioni/" },
  { value: "tnt", label: "TNT (Europe)", url: "https://www.tnt.com/express/en_us/site/tracking.html?searchType=con&cons=" },
  // Asia
  { value: "chinapost", label: "China Post", url: "http://english.chinapost.com.cn/query1/?code=" },
  { value: "sfexpress", label: "SF Express (China)", url: "https://www.sf-express.com/chn/en/dynamic_function/waybill/#search/bill-number/" },
  { value: "yto", label: "YTO Express (China)", url: "https://www.yto.net.cn/service/service.aspx?no=" },
  { value: "sto", label: "STO Express (China)", url: "https://www.sto.cn/query?q=" },
  { value: "zto", label: "ZTO Express (China)", url: "https://www.zto.com/GuestService/Bill?txtBill=" },
  { value: "cainiao", label: "Cainiao (China)", url: "https://global.cainiao.com/detail.htm?mailNoList=" },
  { value: "japanpost", label: "Japan Post", url: "https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=" },
  { value: "sagawa", label: "Sagawa (Japan)", url: "http://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp?okurijoNo=" },
  { value: "yamato", label: "Yamato (Japan)", url: "http://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=" },
  { value: "koreapost", label: "Korea Post", url: "https://trace.epost.go.kr/xtts/servlet/kpl.tts.common.svl.SttSVL?target_command=kpl.tts.tt.epost.cmd.RetrieveOrderListByInvcNoCmd&intc_tel_sqno=" },
  { value: "indiapost", label: "India Post", url: "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?tracknumber=" },
  { value: "singpost", label: "Singapore Post", url: "https://www.singpost.com/track-items?trackingId=" },
  { value: "thaipost", label: "Thailand Post", url: "https://track.thailandpost.co.th/?trackNumber=" },
  { value: "malaysiapost", label: "Malaysia Post", url: "https://track.pos.com.my/?trackingNo=" },
  // Oceania
  { value: "auspost", label: "Australia Post", url: "https://auspost.com.au/track/#/track?id=" },
  { value: "nzpost", label: "New Zealand Post", url: "https://www.nzpost.co.nz/tools/tracking?trackid=" },
  // Middle East & Africa
  { value: "emiratespost", label: "Emirates Post (UAE)", url: "https://www.epg.ae/tracking?shipment_id=" },
  { value: "sapo", label: "South Africa Post", url: "https://www.postoffice.co.za/tools/track-and-trace?tracking=" },
  // Multi-carrier
  { value: "17track", label: "17Track (Multi-carrier)", url: "https://t.17track.net/en#nums=" },
  { value: "aftership", label: "AfterShip (Multi-carrier)", url: "https://track.aftership.com/" },
];

const WorldwideTracking = () => {
  const [trackingNumber, setTrackingNumber] = useState("");
  const [selectedCarrier, setSelectedCarrier] = useState("auto");
  const { toast } = useToast();

  const detectCarrier = (tracking: string): string => {
    const cleaned = tracking.replace(/\s/g, "").toUpperCase();
    
    // Amazon patterns (check early as very distinctive)
    if (/^TBA[0-9]{12}$/.test(cleaned)) {
      return "amazon";
    }
    
    // UPS patterns (check early as very distinctive)
    if (/^1Z[0-9A-Z]{16}$/.test(cleaned)) {
      return "ups";
    }
    
    // OnTrac patterns
    if (/^C[0-9]{14}$/.test(cleaned)) {
      return "ontrac";
    }
    
    // Freight carriers (PRO numbers are typically 7-10 digits)
    // Check for specific freight patterns
    if (/^[0-9]{7,11}$/.test(cleaned)) {
      // Could be any freight carrier - default to 17track for multi-carrier search
      // Most freight PRO numbers fall in this range
      return "17track";
    }
    
    // China carriers
    if (/^[A-Z]{2}[0-9]{9}CN$/.test(cleaned)) {
      return "chinapost";
    }
    if (/^SF[0-9]{12}$/.test(cleaned) || /^[0-9]{12}$/.test(cleaned)) {
      return "sfexpress";
    }
    
    // Japan Post
    if (/^[A-Z]{2}[0-9]{9}JP$/.test(cleaned)) {
      return "japanpost";
    }
    
    // Korea Post
    if (/^[A-Z]{2}[0-9]{9}KR$/.test(cleaned)) {
      return "koreapost";
    }
    
    // Australia Post
    if (/^[A-Z]{2}[0-9]{9}AU$/.test(cleaned)) {
      return "auspost";
    }
    
    // Singapore Post
    if (/^[A-Z]{2}[0-9]{9}SG$/.test(cleaned)) {
      return "singpost";
    }
    
    // India Post
    if (/^[A-Z]{2}[0-9]{9}IN$/.test(cleaned)) {
      return "indiapost";
    }
    
    // Canada Post patterns
    if (/^[0-9]{16}$/.test(cleaned) || /^[A-Z]{2}[0-9]{9}CA$/.test(cleaned)) {
      return "canadapost";
    }
    
    // Royal Mail patterns (UK)
    if (/^[A-Z]{2}[0-9]{9}GB$/.test(cleaned) || /^[A-Z]{2}[0-9]{7}$/.test(cleaned)) {
      return "royalmail";
    }
    
    // La Poste patterns (France)
    if (/^[A-Z]{2}[0-9]{9}FR$/.test(cleaned)) {
      return "laposte";
    }
    
    // Germany Deutsche Post
    if (/^[A-Z]{2}[0-9]{9}DE$/.test(cleaned)) {
      return "deutschepost";
    }
    
    // Spain Correos
    if (/^[A-Z]{2}[0-9]{9}ES$/.test(cleaned)) {
      return "correos";
    }
    
    // Italy Poste Italiane
    if (/^[A-Z]{2}[0-9]{9}IT$/.test(cleaned)) {
      return "posteitaliane";
    }
    
    // Netherlands PostNL
    if (/^[A-Z]{2}[0-9]{9}NL$/.test(cleaned)) {
      return "postnl";
    }
    
    // DPD patterns
    if (/^[0-9]{14}$/.test(cleaned)) {
      return "dpd";
    }
    
    // USPS patterns
    if (/^(94|93|92|95)[0-9]{20}$/.test(cleaned) || 
        /^[A-Z]{2}[0-9]{9}US$/.test(cleaned)) {
      return "usps";
    }
    
    // UPS patterns (numeric only)
    if (/^[0-9]{18}$/.test(cleaned)) {
      return "ups";
    }
    
    // FedEx patterns
    if (/^[0-9]{12}$/.test(cleaned) || /^[0-9]{15}$/.test(cleaned) || /^[0-9]{20}$/.test(cleaned)) {
      return "fedex";
    }
    
    // DHL patterns
    if (/^[0-9]{10}$/.test(cleaned) || /^[0-9]{11}$/.test(cleaned)) {
      return "dhl";
    }
    
    // Default to 17track for multi-carrier search
    return "17track";
  };

  const handleTrack = () => {
    if (!trackingNumber.trim()) {
      toast({
        title: "Error",
        description: "Please enter a tracking number",
        variant: "destructive",
      });
      return;
    }

    const carrier = selectedCarrier === "auto" 
      ? detectCarrier(trackingNumber) 
      : selectedCarrier;
    
    const carrierData = CARRIERS.find(c => c.value === carrier);
    
    if (!carrierData || !carrierData.url) {
      toast({
        title: "Error",
        description: "Could not determine carrier. Please select manually.",
        variant: "destructive",
      });
      return;
    }

    const trackingUrl = carrierData.url + encodeURIComponent(trackingNumber.trim());
    window.open(trackingUrl, '_blank');
    
    toast({
      title: "Tracking Opened",
      description: `Opening ${carrierData.label} tracking in a new tab`,
    });
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleTrack();
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Helmet>
        <title>Worldwide Package Tracking | ArbiProSeller</title>
        <meta name="description" content="Track packages from multiple carriers worldwide including USPS, UPS, FedEx, DHL, Amazon, and more" />
      </Helmet>
      
      <Navbar />
      
      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold mb-4 flex items-center justify-center gap-3">
              <Package className="h-10 w-10 text-primary" />
              Worldwide Package Tracking
            </h1>
            <p className="text-xl text-muted-foreground">
              Track packages from multiple carriers in one place
            </p>
          </div>

          <Card className="mb-8">
            <CardHeader>
              <CardTitle>Enter Tracking Number</CardTitle>
              <CardDescription>
                We'll automatically detect your carrier or you can select it manually
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="tracking-number">Tracking Number</Label>
                <Input
                  id="tracking-number"
                  placeholder="Enter tracking number (e.g., 1Z999AA10123456784)"
                  value={trackingNumber}
                  onChange={(e) => setTrackingNumber(e.target.value)}
                  onKeyPress={handleKeyPress}
                  className="text-lg"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="carrier">Carrier (Optional)</Label>
                <Select value={selectedCarrier} onValueChange={setSelectedCarrier}>
                  <SelectTrigger id="carrier">
                    <SelectValue placeholder="Select carrier" />
                  </SelectTrigger>
                  <SelectContent>
                    {CARRIERS.map((carrier) => (
                      <SelectItem key={carrier.value} value={carrier.value}>
                        {carrier.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button 
                onClick={handleTrack} 
                className="w-full" 
                size="lg"
              >
                <Search className="mr-2 h-5 w-5" />
                Track Package
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Supported Carriers</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {CARRIERS.filter(c => c.value !== "auto").map((carrier) => (
                  <div key={carrier.value} className="flex items-center gap-2 p-3 border rounded-lg hover:bg-muted/50 transition-colors">
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{carrier.label}</span>
                  </div>
                ))}
              </div>
              
              <div className="mt-6 p-4 bg-muted/50 rounded-lg">
                <h3 className="font-semibold mb-2">How it works:</h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Enter your tracking number</li>
                  <li>• We'll auto-detect the carrier or you can select manually</li>
                  <li>• Track your package on the carrier's official website</li>
                  <li>• Works with international and domestic shipments</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
      
      <Footer />
    </div>
  );
};

export default WorldwideTracking;

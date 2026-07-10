import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Copy, Package, X, ArrowLeft, ArrowRight, Save, Calendar, MapPin, Loader2, Search, Building, Truck, DollarSign, Printer, Download, CheckCircle2, AlertTriangle, ExternalLink } from "lucide-react";
import { Code } from "@/components/ui/code";
import { toast } from "@/hooks/use-toast";
import { Product, ShipmentDraft, ShipmentJSON, Box, SellerAddress, TransportationOption, PlacementOption, PlacementShipment } from "@/types/shipment";
import { ReplenishmentDraftManager, saveDraft } from "./ReplenishmentDraftManager";
import { supabase } from "@/integrations/supabase/client";

// Prep categories that Amazon accepts
export const PREP_CATEGORIES = [
  { value: "NO_PREP", label: "No Prep Needed" },
  { value: "POLYBAGGING", label: "Perforated Package / Polybagging" },
  { value: "GRANULAR", label: "Liquids and Granules" },
  { value: "SHARP", label: "Sharp" },
  { value: "SMALL", label: "Small" },
  { value: "SET", label: "Sold as Set" },
  { value: "FRAGILE", label: "Fragile / Glass" },
  { value: "ADULT", label: "Adult" },
  { value: "TEXTILE", label: "Textile / Fabric" },
] as const;

export type PrepCategory = typeof PREP_CATEGORIES[number]['value'];

interface ReplenishItem {
  asin: string;
  sku: string;
  fnsku?: string | null;
  title: string;
  image_url: string | null;
  qtyToShip: number;
  suggestedQty: number;
  requiresExpirationDate?: boolean; // From inventory/prep details
  prepCategory?: PrepCategory; // User-selected prep category
}

interface ReplenishmentShipmentBuilderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ReplenishItem[];
  onUpdateQty: (asin: string, qty: number) => void;
  onRemoveItem: (asin: string) => void;
  initialDraft?: ShipmentDraft | null;
}

type Step = 'products' | 'quantities' | 'boxes' | 'address' | 'shipping' | 'labels';

// Removed FulfillmentCenter interface - no longer needed for manual selection

export function ReplenishmentShipmentBuilder({
  open,
  onOpenChange,
  items,
  onUpdateQty,
  onRemoveItem,
  initialDraft,
}: ReplenishmentShipmentBuilderProps) {
  const [step, setStep] = useState<Step>('products');
  const [draftId, setDraftId] = useState<string>(() => `draft-${Date.now()}`);
  const [draftName, setDraftName] = useState<string>("");
  
  // Step 1: Prep Categories
  const [prepCategories, setPrepCategories] = useState<Record<string, PrepCategory>>({});
  
  // Step 2: Quantities & Expiration
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [expirationDates, setExpirationDates] = useState<Record<string, string>>({});
  
  // Step 3: Boxes
  const [numberOfBoxes, setNumberOfBoxes] = useState(1);
  const [boxQuantities, setBoxQuantities] = useState<Record<string, number[]>>({});
  const [dimensions, setDimensions] = useState({ length: 0, width: 0, height: 0, unit: 'in' as 'in' | 'cm' });
  const [useIdenticalWeights, setUseIdenticalWeights] = useState(true);
  const [commonWeight, setCommonWeight] = useState({ weight: 0, unit: 'lb' as 'lb' | 'kg' });
  const [boxWeights, setBoxWeights] = useState<{ weight: number; unit: 'lb' | 'kg' }[]>([]);
  
  // Step 4: Seller Address
  const [sellerAddress, setSellerAddress] = useState<SellerAddress>({
    businessName: '',
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    stateOrProvinceCode: '',
    postalCode: '',
    countryCode: 'US',
    phone: '',
    email: '',
  });
  const [addressLoaded, setAddressLoaded] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  
  // Warehouse step removed - Amazon auto-selects based on seller settings
  
  // Step 6: Shipping / Transportation
  const [inboundPlanId, setInboundPlanId] = useState<string | null>(null);
  const [amazonShipmentId, setAmazonShipmentId] = useState<string | null>(null);
  const [placementOptions, setPlacementOptions] = useState<PlacementOption[]>([]);
  const [selectedPlacement, setSelectedPlacement] = useState<string | null>(null);
  const [placementStatusNote, setPlacementStatusNote] = useState<string>("");
  const [transportationOptions, setTransportationOptions] = useState<TransportationOption[]>([]);
  const [selectedTransport, setSelectedTransport] = useState<string | null>(null);
  const [loadingShipping, setLoadingShipping] = useState(false);
  const [shippingConfirmed, setShippingConfirmed] = useState(false);
  
  // Step 7: Labels
  const [shippingLabelUrl, setShippingLabelUrl] = useState<string | null>(null);
  const [boxLabelsUrl, setBoxLabelsUrl] = useState<string | null>(null);
  const [loadingLabels, setLoadingLabels] = useState(false);
  
  const [jsonPreview, setJsonPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveDraftName, setSaveDraftName] = useState("");
  
  // Prep classification error state - shows a warning panel with affected SKUs
  const [prepErrorSkus, setPrepErrorSkus] = useState<string[]>([]);

  // Load saved seller address from profile
  useEffect(() => {
    if (open && !addressLoaded) {
      loadSavedAddress();
    }
  }, [open]);

  // Load initial draft when provided
  useEffect(() => {
    if (open && initialDraft) {
      handleLoadDraft(initialDraft);
    }
  }, [open, initialDraft]);

  const loadSavedAddress = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: profile } = await supabase
        .from('profiles')
        .select('business_name, contact_name, address_line1, address_line2, city, state_code, postal_code, country_code, phone, email')
        .eq('id', user.id)
        .single();

      if (profile && profile.business_name) {
        setSellerAddress({
          businessName: profile.business_name || '',
          name: profile.contact_name || '',
          addressLine1: profile.address_line1 || '',
          addressLine2: profile.address_line2 || '',
          city: profile.city || '',
          stateOrProvinceCode: profile.state_code || '',
          postalCode: profile.postal_code || '',
          countryCode: profile.country_code || 'US',
          phone: profile.phone || '',
          email: profile.email || '',
        });
        setAddressLoaded(true);
      }
    } catch (error) {
      console.error('Error loading saved address:', error);
    }
  };

  const saveAddressToProfile = async () => {
    setSavingAddress(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase
        .from('profiles')
        .update({
          business_name: sellerAddress.businessName,
          contact_name: sellerAddress.name,
          address_line1: sellerAddress.addressLine1,
          address_line2: sellerAddress.addressLine2,
          city: sellerAddress.city,
          state_code: sellerAddress.stateOrProvinceCode,
          postal_code: sellerAddress.postalCode,
          country_code: sellerAddress.countryCode,
          phone: sellerAddress.phone,
        })
        .eq('id', user.id);

      if (error) throw error;
      toast({ title: "Address saved", description: "Your address will auto-fill on future shipments" });
      setAddressLoaded(true);
    } catch (error: any) {
      console.error('Error saving address:', error);
      toast({ title: "Error saving address", description: error.message, variant: "destructive" });
    } finally {
      setSavingAddress(false);
    }
  };

  // Initialize quantities from items
  useEffect(() => {
    const initialQty: Record<string, number> = {};
    items.forEach(item => {
      initialQty[item.asin] = quantities[item.asin] ?? item.qtyToShip;
    });
    setQuantities(initialQty);
  }, [items]);

  // Initialize box weights when number of boxes changes
  useEffect(() => {
    setBoxWeights(Array(numberOfBoxes).fill({ weight: 0, unit: 'lb' as 'lb' | 'kg' }));
  }, [numberOfBoxes]);

  const validItems = items.filter(item => (quantities[item.asin] ?? item.qtyToShip) > 0);
  const totalUnits = validItems.reduce((sum, item) => sum + (quantities[item.asin] ?? item.qtyToShip), 0);

  const getCurrentDraft = (): ShipmentDraft => ({
    id: draftId,
    name: draftName || `Shipment ${new Date().toLocaleDateString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    step,
    products: validItems.map(item => ({
      id: item.asin,
      sku: item.sku,
      asin: item.asin,
      fnsku: item.fnsku,
      title: item.title,
      image_url: item.image_url,
      totalQtyToShip: quantities[item.asin] ?? item.qtyToShip,
      expirationDate: expirationDates[item.asin] || null,
      requiresExpirationDate: item.requiresExpirationDate ?? false,
      prepCategory: prepCategories[item.asin] || 'NO_PREP',
    })),
    numberOfBoxes,
    boxes: Array.from({ length: numberOfBoxes }, (_, i) => ({
      boxIndex: i + 1,
      items: validItems.map(item => ({
        productId: item.asin,
        sku: item.sku,
        quantityInThisBox: boxQuantities[item.asin]?.[i] || 0
      })),
      weight: useIdenticalWeights ? commonWeight.weight : (boxWeights[i]?.weight || 0),
      weightUnit: useIdenticalWeights ? commonWeight.unit : (boxWeights[i]?.unit || 'lb'),
    })),
    boxDimensions: { ...dimensions, dimensionUnit: dimensions.unit },
    useIdenticalWeights,
    commonWeight: { weight: commonWeight.weight, weightUnit: commonWeight.unit },
  });

  const handleSaveDraft = (name: string) => {
    const draft = getCurrentDraft();
    draft.name = name;
    setDraftName(name);
    saveDraft(draft);
    toast({ title: "Draft saved", description: name });
  };

  const handleLoadDraft = (draft: ShipmentDraft) => {
    setDraftId(draft.id);
    setDraftName(draft.name);
    // Map old 'warehouse' step to 'shipping' for backwards compatibility
    const mappedStep = draft.step === 'warehouse' as any ? 'shipping' : draft.step;
    setStep(mappedStep as Step);
    
    // Restore quantities and expiration dates
    const qty: Record<string, number> = {};
    const exp: Record<string, string> = {};
    draft.products.forEach(p => {
      qty[p.asin] = p.totalQtyToShip;
      if (p.expirationDate) exp[p.asin] = p.expirationDate;
    });
    setQuantities(qty);
    setExpirationDates(exp);
    
    if (draft.numberOfBoxes) setNumberOfBoxes(draft.numberOfBoxes);
    if (draft.boxDimensions) {
      const bd = draft.boxDimensions;
      setDimensions({ length: bd.length, width: bd.width, height: bd.height, unit: bd.dimensionUnit });
    }
    if (draft.useIdenticalWeights !== undefined) setUseIdenticalWeights(draft.useIdenticalWeights);
    if (draft.commonWeight) setCommonWeight({ weight: draft.commonWeight.weight, unit: draft.commonWeight.weightUnit });
    
    // Restore box quantities
    if (draft.boxes) {
      const bq: Record<string, number[]> = {};
      draft.products.forEach(p => {
        bq[p.asin] = draft.boxes!.map(box => 
          box.items.find(i => i.sku === p.sku)?.quantityInThisBox || 0
        );
      });
      setBoxQuantities(bq);
      
      // Restore box weights
      if (!draft.useIdenticalWeights) {
        setBoxWeights(draft.boxes.map(b => ({ 
          weight: b.weight || 0, 
          unit: b.weightUnit || 'lb' 
        })));
      }
    }
    
    toast({ title: "Draft loaded", description: draft.name });
  };

  const handleNewDraft = () => {
    setDraftId(`draft-${Date.now()}`);
    setDraftName("");
    setStep('products');
    setQuantities({});
    setExpirationDates({});
    setPrepCategories({});
    setNumberOfBoxes(1);
    setBoxQuantities({});
    setDimensions({ length: 0, width: 0, height: 0, unit: 'in' });
    setUseIdenticalWeights(true);
    setCommonWeight({ weight: 0, unit: 'lb' });
    setBoxWeights([]);
    setJsonPreview(null);
    setErrors({});
  };

  // Step navigation
  const handleContinueToQuantities = () => {
    if (validItems.length === 0) {
      toast({
        title: "No items selected",
        description: "Please add quantities to at least one item",
        variant: "destructive",
      });
      return;
    }
    setStep('quantities');
  };

  const handleContinueToBoxes = () => {
    // Validate all items have quantities
    const noQty = validItems.filter(item => !(quantities[item.asin] > 0));
    if (noQty.length > 0) {
      toast({
        title: "Missing quantities",
        description: "All items must have a quantity greater than 0",
        variant: "destructive",
      });
      return;
    }
    
    // Initialize box quantities
    const initial: Record<string, number[]> = {};
    validItems.forEach(item => {
      initial[item.asin] = Array(numberOfBoxes).fill(0);
    });
    setBoxQuantities(initial);
    setStep('boxes');
  };

  const handleNumberOfBoxesChange = (value: string) => {
    const num = parseInt(value);
    setNumberOfBoxes(num);
    
    const newQuantities: Record<string, number[]> = {};
    validItems.forEach(item => {
      newQuantities[item.asin] = Array(num).fill(0);
    });
    setBoxQuantities(newQuantities);
    setBoxWeights(Array(num).fill({ weight: 0, unit: 'lb' }));
    setJsonPreview(null);
  };

  const handleBoxQuantityChange = (asin: string, boxIndex: number, value: string) => {
    const qty = parseInt(value) || 0;
    setBoxQuantities(prev => ({
      ...prev,
      [asin]: (prev[asin] || []).map((q, i) => i === boxIndex ? qty : q)
    }));
    setJsonPreview(null);
  };

  const handleCopyToAll = (asin: string) => {
    const firstBoxQty = boxQuantities[asin]?.[0] || 0;
    setBoxQuantities(prev => ({
      ...prev,
      [asin]: Array(numberOfBoxes).fill(firstBoxQty)
    }));
  };

  const handleBoxWeightChange = (boxIndex: number, weight: number) => {
    setBoxWeights(prev => prev.map((w, i) => i === boxIndex ? { ...w, weight } : w));
  };

  const validateAndGenerateJSON = () => {
    const newErrors: Record<string, string> = {};

    validItems.forEach(item => {
      const itemQty = quantities[item.asin] ?? item.qtyToShip;
      const boxQtys = boxQuantities[item.asin] || [];
      
      if (numberOfBoxes === 1) {
        if (boxQtys[0] !== itemQty) {
          newErrors[item.asin] = `Units in box must equal ${itemQty}`;
        }
      } else {
        const firstQty = boxQtys[0];
        const allIdentical = boxQtys.every(q => q === firstQty);
        
        if (!allIdentical) {
          newErrors[item.asin] = 'Each box for this product must have the same qty';
        } else {
          const totalInBoxes = firstQty * numberOfBoxes;
          if (totalInBoxes !== itemQty) {
            newErrors[item.asin] = `Boxes × qty per box must equal ${itemQty} (currently ${totalInBoxes})`;
          }
        }
      }
    });

    if (!dimensions.length || !dimensions.width || !dimensions.height) {
      newErrors.dimensions = 'All dimensions must be filled';
    }

    // Validate weights
    if (useIdenticalWeights) {
      if (!commonWeight.weight) {
        newErrors.weight = 'Weight must be filled';
      }
    } else {
      boxWeights.forEach((bw, i) => {
        if (!bw.weight) {
          newErrors[`boxWeight_${i}`] = `Box ${i + 1} weight is required`;
        }
      });
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    const shipmentJSON: ShipmentJSON = {
      shipmentId: `REPLENISH-${Date.now()}`,
      shipmentName: draftName || `Shipment ${new Date().toLocaleDateString()}`,
      numberOfBoxes,
      boxDimensions: {
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        dimensionUnit: dimensions.unit
      },
      destinationFulfillmentCenter: null, // Auto-selected by Amazon
      sourceAddress: sellerAddress,
      boxes: Array.from({ length: numberOfBoxes }, (_, i) => ({
        boxIndex: i + 1,
        items: validItems.map(item => ({
          productId: item.asin,
          sku: item.sku,
          quantityInThisBox: boxQuantities[item.asin]?.[i] || 0
        })),
        weight: useIdenticalWeights ? commonWeight.weight : boxWeights[i]?.weight || 0,
        weightUnit: useIdenticalWeights ? commonWeight.unit : boxWeights[i]?.unit || 'lb',
      })),
      products: validItems.map(item => ({
        sku: item.sku,
        asin: item.asin,
        fnsku: item.fnsku,
        title: item.title,
        quantity: quantities[item.asin] ?? item.qtyToShip,
        expirationDate: expirationDates[item.asin] || null,
      }))
    };

    setJsonPreview(JSON.stringify(shipmentJSON, null, 2));
  };

  // Create inbound plan and proceed to shipping step
  const handleProceedToShipping = async () => {
    // Validate we have products first
    if (validItems.length === 0) {
      toast({ 
        title: "No products to ship", 
        description: "Please add products with quantities before creating an inbound plan.",
        variant: "destructive" 
      });
      return;
    }

    validateAndGenerateJSON();
    if (Object.keys(errors).length > 0) return;

    // Clear any previous prep error before retry
    setPrepErrorSkus([]);
    setLoadingShipping(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "Not authenticated", variant: "destructive" });
        return;
      }

      const shipmentData = {
        shipmentId: `REPLENISH-${Date.now()}`,
        numberOfBoxes,
        boxDimensions: {
          length: dimensions.length,
          width: dimensions.width,
          height: dimensions.height,
          dimensionUnit: dimensions.unit
        },
        boxes: Array.from({ length: numberOfBoxes }, (_, i) => ({
          boxIndex: i + 1,
          items: validItems.map(item => ({
            productId: item.asin,
            sku: item.sku,
            quantityInThisBox: boxQuantities[item.asin]?.[i] || 0
          })),
          weight: useIdenticalWeights ? commonWeight.weight : boxWeights[i]?.weight || 0,
          weightUnit: useIdenticalWeights ? commonWeight.unit : boxWeights[i]?.unit || 'lb',
        })),
        products: validItems.map(item => ({
          sku: item.sku,
          asin: item.asin,
          fnsku: item.fnsku,
          title: item.title,
          quantity: quantities[item.asin] ?? item.qtyToShip,
          expirationDate: expirationDates[item.asin] || null,
          prepCategory: prepCategories[item.asin] || 'NO_PREP',
        })),
        sourceAddress: sellerAddress,
      };

      // Create inbound plan
      const response = await supabase.functions.invoke('create-inbound-plan', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { shipmentData },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const { inboundPlanId: planId, placementOptions: options } = response.data;
      setInboundPlanId(planId);
      setPlacementOptions(options || []);
      
      if (options && options.length > 0) {
        setSelectedPlacement(options[0].placementOptionId);
        // If there's a shipment ID in the placement, save it
        if (options[0].shipmentIds && options[0].shipmentIds.length > 0) {
          setAmazonShipmentId(options[0].shipmentIds[0]);
        }
      }

      setStep('shipping');
      toast({
        title: "Inbound plan created",
        description: (options && options.length > 0)
          ? "Select a warehouse option below"
          : "Amazon is still generating warehouse options. Click Refresh in the next step.",
      });
    } catch (error: any) {
      console.error("Error creating inbound plan:", error);

      const errorMessage = error?.message || "";

      // Supabase errors often look like:
      // "Edge function returned 400: Error, { ...json... }"
      // Try to extract the JSON so we can show the exact SKUs.
      let skuList: string[] = [];
      try {
        const jsonStart = errorMessage.indexOf("{");
        if (jsonStart >= 0) {
          const parsed = JSON.parse(errorMessage.slice(jsonStart));
          const problems = parsed?.details;
          if (Array.isArray(problems)) {
            skuList = problems
              .map((p: any) => {
                const match = String(p?.details || "").match(/resource '([^']+)'/);
                return match?.[1];
              })
              .filter(Boolean);
          }
        }
      } catch {
        // ignore parse failures
      }

      const isPrepClassificationError =
        errorMessage.includes("FBA_INB_0182") ||
        errorMessage.includes("Prep classification") ||
        errorMessage.includes("prep category");

      if (isPrepClassificationError) {
        // Show the prep error panel with affected SKUs
        setPrepErrorSkus(skuList.length ? skuList : items.map(i => i.sku));
        return;
      }

      toast({
        title: "Error creating inbound plan",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setLoadingShipping(false);
    }
  };

  const handleRefreshPlacementOptions = async () => {
    if (!inboundPlanId) return;

    setLoadingShipping(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: "Not authenticated", variant: "destructive" });
        return;
      }

      const res = await supabase.functions.invoke('list-placement-options', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { inboundPlanId },
      });

      if (res.error) throw new Error(res.error.message);

      const options = res.data?.placementOptions || [];
      setPlacementOptions(options);
      setPlacementStatusNote(res.data?.note || "");

      if (options.length > 0) {
        setSelectedPlacement(options[0].placementOptionId);
        if (options[0].shipmentIds && options[0].shipmentIds.length > 0) {
          setAmazonShipmentId(options[0].shipmentIds[0]);
        }
        toast({ title: "Warehouses loaded", description: `Found ${options.length} option(s). Select one to continue.` });
      } else {
        toast({ title: "Still processing", description: "Amazon hasn't returned warehouse options yet. Check the note and try again in 30–60 seconds." });
      }
    } catch (e: any) {
      toast({ title: "Refresh failed", description: e.message, variant: "destructive" });
    } finally {
      setLoadingShipping(false);
    }
  };

  // Confirm placement and get transportation options
  const handleConfirmPlacement = async () => {
    if (!inboundPlanId || !selectedPlacement) return;
    
    setLoadingShipping(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // Confirm placement
      const confirmRes = await supabase.functions.invoke('confirm-placement', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { inboundPlanId, placementOptionId: selectedPlacement },
      });

      if (confirmRes.error) {
        throw new Error(confirmRes.error.message);
      }

      // Wait a moment for Amazon to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get the shipment ID from the selected placement
      const placement = placementOptions.find(p => p.placementOptionId === selectedPlacement);
      const shipmentId = placement?.shipmentIds?.[0] || amazonShipmentId;
      
      if (!shipmentId) {
        toast({ title: "No shipment ID found", variant: "destructive" });
        return;
      }

      setAmazonShipmentId(shipmentId);

      // Get transportation options
      const transportRes = await supabase.functions.invoke('get-transportation-options', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { inboundPlanId, shipmentId },
      });

      if (transportRes.error) {
        throw new Error(transportRes.error.message);
      }

      const { transportationOptions: options, partneredCarrierOptions } = transportRes.data;
      // Prefer partnered carrier options (discounted rates)
      setTransportationOptions(partneredCarrierOptions?.length > 0 ? partneredCarrierOptions : options || []);
      
      if (options && options.length > 0) {
        setSelectedTransport(options[0].transportationOptionId);
      }

      toast({ title: "Placement confirmed", description: "Select shipping carrier below" });
    } catch (error: any) {
      console.error("Error confirming placement:", error);
      toast({ 
        title: "Error", 
        description: error.message,
        variant: "destructive" 
      });
    } finally {
      setLoadingShipping(false);
    }
  };

  // Purchase shipping label
  const handlePurchaseShipping = async () => {
    if (!inboundPlanId || !amazonShipmentId || !selectedTransport) return;
    
    setLoadingShipping(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const confirmRes = await supabase.functions.invoke('confirm-transportation', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { 
          inboundPlanId, 
          shipmentId: amazonShipmentId, 
          transportationOptionId: selectedTransport 
        },
      });

      if (confirmRes.error) {
        throw new Error(confirmRes.error.message);
      }

      setShippingConfirmed(true);
      toast({ title: "Shipping purchased!", description: "Proceed to print labels" });
    } catch (error: any) {
      console.error("Error purchasing shipping:", error);
      toast({ 
        title: "Error purchasing shipping", 
        description: error.message,
        variant: "destructive" 
      });
    } finally {
      setLoadingShipping(false);
    }
  };

  // Proceed to labels step
  const handleProceedToLabels = () => {
    setStep('labels');
    fetchLabels();
  };

  // Fetch shipping and box labels
  const fetchLabels = async () => {
    if (!inboundPlanId || !amazonShipmentId) return;
    
    setLoadingLabels(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      // Get shipping labels
      const labelsRes = await supabase.functions.invoke('get-shipping-labels', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { inboundPlanId, shipmentId: amazonShipmentId },
      });

      if (labelsRes.data?.downloadUrls?.shippingLabel) {
        setShippingLabelUrl(labelsRes.data.downloadUrls.shippingLabel);
      }
      if (labelsRes.data?.downloadUrls?.boxLabels) {
        setBoxLabelsUrl(labelsRes.data.downloadUrls.boxLabels);
      }

      // Get box labels with 2D barcodes
      const boxRes = await supabase.functions.invoke('get-box-labels', {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: { 
          inboundPlanId, 
          shipmentId: amazonShipmentId,
          numberOfPackages: numberOfBoxes,
        },
      });

      if (boxRes.data?.downloadUrl) {
        setBoxLabelsUrl(boxRes.data.downloadUrl);
      }

      toast({ title: "Labels ready", description: "Download and print your labels" });
    } catch (error: any) {
      console.error("Error fetching labels:", error);
      toast({ 
        title: "Error fetching labels", 
        description: error.message,
        variant: "destructive" 
      });
    } finally {
      setLoadingLabels(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  // Removed fetchFulfillmentCenters - no longer needed, Amazon auto-selects warehouses

  const handleContinueToAddress = () => {
    // Validate boxes first
    const newErrors: Record<string, string> = {};

    validItems.forEach(item => {
      const itemQty = quantities[item.asin] ?? item.qtyToShip;
      const boxQtys = boxQuantities[item.asin] || [];
      
      if (numberOfBoxes === 1) {
        if (boxQtys[0] !== itemQty) {
          newErrors[item.asin] = `Units in box must equal ${itemQty}`;
        }
      } else {
        const firstQty = boxQtys[0];
        const allIdentical = boxQtys.every(q => q === firstQty);
        
        if (!allIdentical) {
          newErrors[item.asin] = 'Each box for this product must have the same qty';
        } else {
          const totalInBoxes = firstQty * numberOfBoxes;
          if (totalInBoxes !== itemQty) {
            newErrors[item.asin] = `Boxes × qty per box must equal ${itemQty} (currently ${totalInBoxes})`;
          }
        }
      }
    });

    if (!dimensions.length || !dimensions.width || !dimensions.height) {
      newErrors.dimensions = 'All dimensions must be filled';
    }

    if (useIdenticalWeights) {
      if (!commonWeight.weight) {
        newErrors.weight = 'Weight must be filled';
      }
    } else {
      boxWeights.forEach((bw, i) => {
        if (!bw.weight) {
          newErrors[`boxWeight_${i}`] = `Box ${i + 1} weight is required`;
        }
      });
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    // Proceed to address step
    setStep('address');
  };

  const handleContinueToWarehouse = () => {
    // Validate seller address
    const newErrors: Record<string, string> = {};

    if (!sellerAddress.businessName.trim()) {
      newErrors.businessName = 'Business name is required';
    }
    if (!sellerAddress.name.trim()) {
      newErrors.name = 'Contact name is required';
    }
    if (!sellerAddress.addressLine1.trim()) {
      newErrors.addressLine1 = 'Address is required';
    }
    if (!sellerAddress.city.trim()) {
      newErrors.city = 'City is required';
    }
    if (!sellerAddress.stateOrProvinceCode.trim()) {
      newErrors.stateOrProvinceCode = 'State is required';
    }
    if (!sellerAddress.postalCode.trim()) {
      newErrors.postalCode = 'Postal code is required';
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    // Proceed directly to shipping step (warehouse is auto-selected by Amazon)
    setStep('shipping');
    handleProceedToShipping();
  };

  const stepTitles: Record<Step, string> = {
    products: 'Step 1: Select Products',
    quantities: 'Step 2: Set Quantities & Expiration',
    boxes: 'Step 3: Configure Boxes',
    address: 'Step 4: Seller Address',
    shipping: 'Step 5: Shipping & Warehouses',
    labels: 'Step 6: Print Labels',
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Create Replenishment Shipment - {stepTitles[step]}
            </DialogTitle>
            <ReplenishmentDraftManager
              currentDraft={getCurrentDraft()}
              onLoadDraft={handleLoadDraft}
              onSaveDraft={handleSaveDraft}
              onNewDraft={handleNewDraft}
            />
          </div>
          {draftName && (
            <div className="text-sm text-muted-foreground">Draft: {draftName}</div>
          )}
        </DialogHeader>

        {/* Step 1: Products */}
        {step === 'products' && (
          <div className="space-y-4">
            {/* Prep Classification Error Panel */}
            {prepErrorSkus.length > 0 && (
              <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-sm font-semibold">
                  Prep Category Required in Seller Central
                </AlertTitle>
                <AlertDescription className="text-xs space-y-3 mt-2">
                  <p>
                    Amazon requires a one-time prep category setup for these SKUs before they can be shipped via API.
                  </p>
                  <div className="bg-background/50 rounded p-2 border border-destructive/20">
                    <p className="font-medium mb-1">Affected SKUs:</p>
                    <div className="flex flex-wrap gap-1">
                      {prepErrorSkus.map(sku => (
                        <code key={sku} className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-mono">
                          {sku}
                        </code>
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-6 text-xs"
                      onClick={() => {
                        navigator.clipboard.writeText(prepErrorSkus.join(", "));
                        toast({ title: "SKUs copied to clipboard" });
                      }}
                    >
                      <Copy className="h-3 w-3 mr-1" /> Copy SKUs
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium">How to fix (one-time per SKU):</p>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                      <li>Go to <strong>Seller Central → Inventory → Send to Amazon</strong></li>
                      <li>Create a new draft shipment with these SKUs</li>
                      <li>Amazon will prompt you to select a Prep Category for each</li>
                      <li>Save the draft (you can delete it after)</li>
                      <li>Return here and retry — it will work!</li>
                    </ol>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => window.open("https://sellercentral.amazon.com/fba/sendtoamazon", "_blank")}
                    >
                      <ExternalLink className="h-3 w-3 mr-1" /> Open Seller Central
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setPrepErrorSkus([])}
                    >
                      Dismiss
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <p className="text-muted-foreground text-sm">
              Review selected products and choose the prep category for each. This tells Amazon how to handle the items.
            </p>

            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="px-3 py-2 text-left text-xs">Image</th>
                    <th className="px-3 py-2 text-left text-xs">ASIN/SKU</th>
                    <th className="px-3 py-2 text-left text-xs">Title</th>
                    <th className="px-3 py-2 text-left text-xs">Prep Category</th>
                    <th className="px-3 py-2 text-center text-xs">Suggested Qty</th>
                    <th className="px-3 py-2 text-center text-xs">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.asin} className="border-b">
                      <td className="px-3 py-2">
                        {item.image_url ? (
                          <img src={item.image_url} alt="" className="w-10 h-10 object-cover rounded" />
                        ) : (
                          <div className="w-10 h-10 bg-muted rounded flex items-center justify-center text-[10px]">
                            N/A
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-xs font-mono text-primary">{item.asin}</div>
                        <div className="text-[10px] text-muted-foreground">{item.sku}</div>
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[150px] truncate">{item.title}</td>
                      <td className="px-3 py-2">
                        <Select
                          value={prepCategories[item.asin] || 'NO_PREP'}
                          onValueChange={(value) => 
                            setPrepCategories(prev => ({ ...prev, [item.asin]: value as PrepCategory }))
                          }
                        >
                          <SelectTrigger className="w-[160px] h-8 text-xs">
                            <SelectValue placeholder="Select prep..." />
                          </SelectTrigger>
                          <SelectContent>
                            {PREP_CATEGORIES.map(cat => (
                              <SelectItem key={cat.value} value={cat.value} className="text-xs">
                                {cat.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="px-3 py-2 text-center text-xs text-amber-500 font-medium">
                        {item.suggestedQty}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                          onClick={() => onRemoveItem(item.asin)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {items.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No items selected for replenishment
              </div>
            ) : (
              <div className="flex items-center justify-between pt-4 border-t">
                <div className="text-sm">
                  <span className="text-muted-foreground">Total: </span>
                  <span className="font-semibold">{items.length} products</span>
                </div>
                <Button onClick={handleContinueToQuantities} disabled={items.length === 0}>
                  Continue to Quantities <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Quantities & Expiration Dates */}
        {step === 'quantities' && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Set the quantity for each product. Expiration date is shown for products that require it.
            </p>

            <div className="overflow-x-auto border rounded-lg">
              <table className="w-full">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="px-3 py-2 text-left text-xs">Image</th>
                    <th className="px-3 py-2 text-left text-xs">Product</th>
                    <th className="px-3 py-2 text-center text-xs">Suggested</th>
                    <th className="px-3 py-2 text-center text-xs">Quantity to Ship</th>
                    <th className="px-3 py-2 text-center text-xs">Expiration Date</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const requiresExpiration = item.requiresExpirationDate ?? false;
                    return (
                      <tr key={item.asin} className="border-b">
                        <td className="px-3 py-2">
                          {item.image_url ? (
                            <img src={item.image_url} alt="" className="w-10 h-10 object-cover rounded" />
                          ) : (
                            <div className="w-10 h-10 bg-muted rounded flex items-center justify-center text-[10px]">
                              N/A
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-xs font-medium truncate max-w-[180px]">{item.title}</div>
                          <div className="text-[10px] text-muted-foreground">{item.sku}</div>
                        </td>
                        <td className="px-3 py-2 text-center text-xs text-amber-500 font-medium">
                          {item.suggestedQty}
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            min="0"
                            value={(quantities[item.asin] ?? item.qtyToShip) || ''}
                            onChange={(e) => {
                              const val = parseInt(e.target.value) || 0;
                              setQuantities(prev => ({ ...prev, [item.asin]: val }));
                              onUpdateQty(item.asin, val);
                            }}
                            className="w-24 h-8 text-center mx-auto"
                          />
                        </td>
                        <td className="px-3 py-2">
                          {requiresExpiration ? (
                            <div className="flex items-center gap-1 justify-center">
                              <Input
                                type="date"
                                value={expirationDates[item.asin] || ''}
                                onChange={(e) => setExpirationDates(prev => ({ ...prev, [item.asin]: e.target.value }))}
                                className="w-36 h-8 text-xs"
                                min={new Date().toISOString().split('T')[0]}
                              />
                              {expirationDates[item.asin] && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => setExpirationDates(prev => {
                                    const next = { ...prev };
                                    delete next[item.asin];
                                    return next;
                                  })}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep('products')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <div className="text-sm">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-semibold">{validItems.length} products, {totalUnits} units</span>
              </div>
              <Button onClick={handleContinueToBoxes} disabled={validItems.length === 0}>
                Continue to Boxes <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Configure Boxes */}
        {step === 'boxes' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-muted-foreground text-sm">
                  All boxes will have identical contents and dimensions. Set weight per box below.
                </p>
              </div>
              <Button variant="outline" onClick={() => setStep('quantities')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
            </div>

            <Card className="p-4">
              <div className="mb-4">
                <Label htmlFor="numBoxes">Number of Identical Boxes</Label>
                <Select value={numberOfBoxes.toString()} onValueChange={handleNumberOfBoxesChange}>
                  <SelectTrigger id="numBoxes" className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30].map(n => (
                      <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 text-xs">Product</th>
                      <th className="text-center py-2 px-3 w-20 text-xs">Total Qty</th>
                      {numberOfBoxes === 1 ? (
                        <th className="text-center py-2 px-3 w-28 text-xs">Units in Box</th>
                      ) : (
                        Array.from({ length: Math.min(numberOfBoxes, 5) }, (_, i) => (
                          <th key={i} className="text-center py-2 px-3 w-20 text-xs">Box {i + 1}</th>
                        ))
                      )}
                      {numberOfBoxes > 5 && (
                        <th className="text-center py-2 px-3 text-xs">...</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {validItems.map(item => {
                      const itemQty = quantities[item.asin] ?? item.qtyToShip;
                      return (
                        <tr key={item.asin} className="border-b">
                          <td className="py-2 px-3">
                            <div className="text-xs font-medium truncate max-w-[150px]">{item.title}</div>
                            <div className="text-[10px] text-muted-foreground">{item.sku}</div>
                            {errors[item.asin] && (
                              <div className="text-[10px] text-destructive mt-1">{errors[item.asin]}</div>
                            )}
                          </td>
                          <td className="py-2 px-3 text-center font-semibold text-xs">{itemQty}</td>
                          {numberOfBoxes === 1 ? (
                            <td className="py-2 px-3">
                              <Input
                                type="number"
                                min="0"
                                value={boxQuantities[item.asin]?.[0] || ''}
                                onChange={(e) => handleBoxQuantityChange(item.asin, 0, e.target.value)}
                                className="w-20 h-8 text-center mx-auto"
                              />
                            </td>
                          ) : (
                            <>
                              {Array.from({ length: Math.min(numberOfBoxes, 5) }, (_, i) => (
                                <td key={i} className="py-2 px-3">
                                  <div className="flex items-center gap-1 justify-center">
                                    <Input
                                      type="number"
                                      min="0"
                                      value={boxQuantities[item.asin]?.[i] || ''}
                                      onChange={(e) => handleBoxQuantityChange(item.asin, i, e.target.value)}
                                      className="w-16 h-8 text-center"
                                    />
                                    {i === 0 && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8"
                                        onClick={() => handleCopyToAll(item.asin)}
                                        title="Copy to all boxes"
                                      >
                                        <Copy className="h-3 w-3" />
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              ))}
                              {numberOfBoxes > 5 && (
                                <td className="py-2 px-3 text-center text-xs text-muted-foreground">
                                  +{numberOfBoxes - 5} more
                                </td>
                              )}
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Box Dimensions */}
              <div className="mt-6">
                <h4 className="font-medium mb-3 text-sm">Box Dimensions (all boxes identical)</h4>
                <div className="grid grid-cols-4 gap-2 max-w-md">
                  <div>
                    <Label className="text-xs">Length</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dimensions.length || ''}
                      onChange={(e) => setDimensions(prev => ({ ...prev, length: parseFloat(e.target.value) || 0 }))}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Width</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dimensions.width || ''}
                      onChange={(e) => setDimensions(prev => ({ ...prev, width: parseFloat(e.target.value) || 0 }))}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Height</Label>
                    <Input
                      type="number"
                      min="0"
                      value={dimensions.height || ''}
                      onChange={(e) => setDimensions(prev => ({ ...prev, height: parseFloat(e.target.value) || 0 }))}
                      className="h-8"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Unit</Label>
                    <Select value={dimensions.unit} onValueChange={(v) => setDimensions(prev => ({ ...prev, unit: v as 'in' | 'cm' }))}>
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="in">in</SelectItem>
                        <SelectItem value="cm">cm</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {errors.dimensions && (
                  <div className="text-xs text-destructive mt-1">{errors.dimensions}</div>
                )}
              </div>

              {/* Box Weights */}
              <div className="mt-6">
                <div className="flex items-center gap-4 mb-3">
                  <h4 className="font-medium text-sm">Box Weight</h4>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="identicalWeights"
                      checked={useIdenticalWeights}
                      onCheckedChange={(checked) => setUseIdenticalWeights(!!checked)}
                    />
                    <Label htmlFor="identicalWeights" className="text-xs">All boxes have identical weight</Label>
                  </div>
                </div>
                
                {useIdenticalWeights ? (
                  <div className="grid grid-cols-2 gap-2 max-w-xs">
                    <div>
                      <Label className="text-xs">Weight</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={commonWeight.weight || ''}
                        onChange={(e) => setCommonWeight(prev => ({ ...prev, weight: parseFloat(e.target.value) || 0 }))}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Unit</Label>
                      <Select value={commonWeight.unit} onValueChange={(v) => setCommonWeight(prev => ({ ...prev, unit: v as 'lb' | 'kg' }))}>
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="lb">lb</SelectItem>
                          <SelectItem value="kg">kg</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    {Array.from({ length: numberOfBoxes }, (_, i) => (
                      <div key={i} className="border rounded p-2">
                        <Label className="text-xs font-medium">Box {i + 1}</Label>
                        <div className="flex gap-1 mt-1">
                          <Input
                            type="number"
                            min="0"
                            step="0.1"
                            value={boxWeights[i]?.weight || ''}
                            onChange={(e) => handleBoxWeightChange(i, parseFloat(e.target.value) || 0)}
                            className="h-7 text-xs"
                            placeholder="Weight"
                          />
                          <Select 
                            value={boxWeights[i]?.unit || 'lb'} 
                            onValueChange={(v) => setBoxWeights(prev => prev.map((w, idx) => idx === i ? { ...w, unit: v as 'lb' | 'kg' } : w))}
                          >
                            <SelectTrigger className="h-7 w-14 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="lb">lb</SelectItem>
                              <SelectItem value="kg">kg</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {errors[`boxWeight_${i}`] && (
                          <div className="text-[10px] text-destructive mt-1">{errors[`boxWeight_${i}`]}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {errors.weight && (
                  <div className="text-xs text-destructive mt-1">{errors.weight}</div>
                )}
              </div>
            </Card>

            <div className="flex items-center justify-between pt-4">
              <Button variant="outline" onClick={() => setStep('quantities')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <div className="text-sm">
                <span className="text-muted-foreground">Total: </span>
                <span className="font-semibold">{validItems.length} products, {totalUnits} units, {numberOfBoxes} boxes</span>
              </div>
              <Button onClick={handleContinueToAddress}>
                Seller Address <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Seller Address */}
        {step === 'address' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-sm">
                Enter your business address. This will be printed on the shipping label as "FBA-[Business Name]".
              </p>
              {addressLoaded && (
                <span className="text-xs text-green-600 flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Saved
                </span>
              )}
            </div>

            <Card className="p-4">
              <div className="grid gap-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-medium">Business Name *</Label>
                    <Input
                      value={sellerAddress.businessName}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, businessName: e.target.value }))}
                      placeholder="Your Company LLC"
                      className="h-9"
                    />
                    {errors.businessName && (
                      <div className="text-xs text-destructive mt-1">{errors.businessName}</div>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Contact Name *</Label>
                    <Input
                      value={sellerAddress.name}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="John Smith"
                      className="h-9"
                    />
                    {errors.name && (
                      <div className="text-xs text-destructive mt-1">{errors.name}</div>
                    )}
                  </div>
                </div>

                <div>
                  <Label className="text-xs font-medium">Address Line 1 *</Label>
                  <Input
                    value={sellerAddress.addressLine1}
                    onChange={(e) => setSellerAddress(prev => ({ ...prev, addressLine1: e.target.value }))}
                    placeholder="123 Main Street"
                    className="h-9"
                  />
                  {errors.addressLine1 && (
                    <div className="text-xs text-destructive mt-1">{errors.addressLine1}</div>
                  )}
                </div>

                <div>
                  <Label className="text-xs font-medium">Address Line 2</Label>
                  <Input
                    value={sellerAddress.addressLine2 || ''}
                    onChange={(e) => setSellerAddress(prev => ({ ...prev, addressLine2: e.target.value }))}
                    placeholder="Suite 100, Building A"
                    className="h-9"
                  />
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs font-medium">City *</Label>
                    <Input
                      value={sellerAddress.city}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, city: e.target.value }))}
                      placeholder="Seattle"
                      className="h-9"
                    />
                    {errors.city && (
                      <div className="text-xs text-destructive mt-1">{errors.city}</div>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs font-medium">State *</Label>
                    <Input
                      value={sellerAddress.stateOrProvinceCode}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, stateOrProvinceCode: e.target.value.toUpperCase() }))}
                      placeholder="WA"
                      maxLength={2}
                      className="h-9"
                    />
                    {errors.stateOrProvinceCode && (
                      <div className="text-xs text-destructive mt-1">{errors.stateOrProvinceCode}</div>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Postal Code *</Label>
                    <Input
                      value={sellerAddress.postalCode}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, postalCode: e.target.value }))}
                      placeholder="98101"
                      className="h-9"
                    />
                    {errors.postalCode && (
                      <div className="text-xs text-destructive mt-1">{errors.postalCode}</div>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Country</Label>
                    <Select 
                      value={sellerAddress.countryCode} 
                      onValueChange={(v) => setSellerAddress(prev => ({ ...prev, countryCode: v }))}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="US">United States</SelectItem>
                        <SelectItem value="CA">Canada</SelectItem>
                        <SelectItem value="MX">Mexico</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs font-medium">Phone</Label>
                    <Input
                      value={sellerAddress.phone || ''}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, phone: e.target.value }))}
                      placeholder="(555) 123-4567"
                      className="h-9"
                    />
                  </div>
                  <div>
                    <Label className="text-xs font-medium">Email</Label>
                    <Input
                      value={sellerAddress.email || ''}
                      onChange={(e) => setSellerAddress(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="contact@company.com"
                      className="h-9"
                    />
                  </div>
                </div>
              </div>
            </Card>

            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep('boxes')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={saveAddressToProfile} disabled={savingAddress || !sellerAddress.businessName}>
                  {savingAddress ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save Address
                </Button>
              </div>
              <Button onClick={handleContinueToWarehouse} disabled={loadingShipping}>
                {loadingShipping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                Continue to Shipping
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Shipping / Transportation */}
        {step === 'shipping' && (
          <div className="space-y-4">
            {loadingShipping && placementOptions.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Creating inbound plan & finding optimal warehouses...</span>
              </div>
            )}

            {loadingShipping && placementOptions.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-2 text-muted-foreground">Creating inbound plan & finding optimal warehouses...</span>
              </div>
            )}

            {!loadingShipping && placementOptions.length === 0 && inboundPlanId && !shippingConfirmed && (
              <Card className="p-4">
                <h4 className="font-medium mb-2">Waiting for Amazon warehouse options</h4>
                <p className="text-sm text-muted-foreground">
                  Amazon sometimes needs a minute to generate placement (warehouse) options.
                </p>
                <Button className="mt-4 w-full" onClick={handleRefreshPlacementOptions} disabled={loadingShipping}>
                  <Truck className="mr-2 h-4 w-4" /> Refresh warehouse options
                </Button>
                {placementStatusNote && (
                  <p className="mt-3 text-xs text-muted-foreground whitespace-pre-wrap">
                    {placementStatusNote}
                  </p>
                )}
              </Card>
            )}

            {placementOptions.length > 0 && transportationOptions.length === 0 && !shippingConfirmed && (
              <Card className="p-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <MapPin className="h-4 w-4" /> Auto-Selected Warehouses
                </h4>
                <p className="text-sm text-muted-foreground mb-4">
                  Amazon automatically selected the optimal warehouse(s) based on your settings to minimize placement fees.
                </p>
                <div className="space-y-3">
                  {placementOptions.map((opt) => (
                    <div
                      key={opt.placementOptionId}
                      className={`p-4 border rounded-lg cursor-pointer transition-all ${
                        selectedPlacement === opt.placementOptionId 
                          ? 'border-primary bg-primary/5 ring-2 ring-primary/20' 
                          : opt.isRecommended 
                            ? 'border-green-500/50 bg-green-50/50 dark:bg-green-950/20' 
                            : ''
                      }`}
                      onClick={() => setSelectedPlacement(opt.placementOptionId)}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {opt.isRecommended && (
                            <span className="text-xs bg-green-500 text-white px-2 py-0.5 rounded-full">Recommended</span>
                          )}
                          <span className="text-sm font-medium">
                            {opt.shipments?.length || opt.shipmentIds?.length || 1} Warehouse(s)
                          </span>
                        </div>
                        {(opt.netCost !== undefined && opt.netCost !== 0) && (
                          <div className={`text-sm font-medium ${opt.netCost > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                            {opt.netCost > 0 ? `+$${opt.netCost.toFixed(2)} fees` : `$${Math.abs(opt.netCost).toFixed(2)} savings`}
                          </div>
                        )}
                      </div>
                      
                      {/* Show destination warehouses */}
                      {opt.shipments && opt.shipments.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 mt-3">
                          {opt.shipments.map((shipment) => (
                            <div key={shipment.shipmentId} className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-1.5">
                              <Building className="h-3 w-3 text-primary shrink-0" />
                              <div className="truncate">
                                <span className="font-medium">{shipment.destinationFcId}</span>
                                {shipment.destinationFcName && shipment.destinationFcName !== shipment.destinationFcId && (
                                  <span className="text-muted-foreground ml-1">({shipment.destinationFcName})</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Fallback if no shipment details */}
                      {(!opt.shipments || opt.shipments.length === 0) && opt.shipmentIds && (
                        <div className="text-xs text-muted-foreground mt-2">
                          Shipment IDs: {opt.shipmentIds.slice(0, 3).join(', ')}{opt.shipmentIds.length > 3 ? '...' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <Button 
                  className="mt-4 w-full" 
                  onClick={handleConfirmPlacement} 
                  disabled={!selectedPlacement || loadingShipping}
                >
                  {loadingShipping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Truck className="mr-2 h-4 w-4" />}
                  Confirm & Get Shipping Rates
                </Button>
              </Card>
            )}

            {transportationOptions.length > 0 && !shippingConfirmed && (
              <Card className="p-4">
                <h4 className="font-medium mb-3 flex items-center gap-2">
                  <Truck className="h-4 w-4" /> Shipping Options (UPS via Amazon)
                </h4>
                <p className="text-sm text-muted-foreground mb-3">
                  Amazon Partnered Carrier rates are typically 30-50% cheaper than retail rates.
                </p>
                <div className="space-y-2">
                  {transportationOptions.map((opt) => (
                    <div
                      key={opt.transportationOptionId}
                      className={`p-3 border rounded-lg cursor-pointer transition-all ${
                        selectedTransport === opt.transportationOptionId ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => setSelectedTransport(opt.transportationOptionId)}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium">{opt.carrier}</div>
                          <div className="text-xs text-muted-foreground">{opt.shippingSolution}</div>
                        </div>
                        {opt.quote && (
                          <div className="text-right">
                            <div className="font-bold text-primary flex items-center">
                              <DollarSign className="h-4 w-4" />
                              {opt.quote.amount.toFixed(2)}
                            </div>
                            <div className="text-xs text-muted-foreground">{opt.quote.currency}</div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <Button className="mt-4 w-full" onClick={handlePurchaseShipping} disabled={!selectedTransport || loadingShipping}>
                  {loadingShipping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <DollarSign className="mr-2 h-4 w-4" />}
                  Purchase Shipping Label
                </Button>
              </Card>
            )}

            {shippingConfirmed && (
              <Card className="p-4 border-green-500 bg-green-50 dark:bg-green-950/20">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-6 w-6 text-green-500" />
                  <div>
                    <div className="font-medium text-green-700 dark:text-green-400">Shipping Purchased!</div>
                    <div className="text-sm text-green-600 dark:text-green-500">Your UPS label is ready</div>
                  </div>
                </div>
              </Card>
            )}

            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep('address')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleProceedToLabels} disabled={!shippingConfirmed}>
                <Printer className="mr-2 h-4 w-4" /> Print Labels
              </Button>
            </div>
          </div>
        )}

        {/* Step 7: Labels */}
        {step === 'labels' && (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Download and print your shipping label and FBA box labels (2D barcodes).
            </p>

            {loadingLabels ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span className="ml-2">Loading labels...</span>
              </div>
            ) : (
              <div className="grid gap-4">
                <Card className="p-4">
                  <h4 className="font-medium mb-3 flex items-center gap-2">
                    <Truck className="h-4 w-4" /> UPS Shipping Label
                  </h4>
                  {shippingLabelUrl ? (
                    <Button asChild className="w-full">
                      <a href={shippingLabelUrl} target="_blank" rel="noopener noreferrer">
                        <Download className="mr-2 h-4 w-4" /> Download Shipping Label (PDF)
                      </a>
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">Shipping label will be available shortly...</p>
                  )}
                </Card>

                <Card className="p-4">
                  <h4 className="font-medium mb-3 flex items-center gap-2">
                    <Package className="h-4 w-4" /> FBA Box Labels (2D Barcodes)
                  </h4>
                  <p className="text-xs text-muted-foreground mb-3">
                    Print and attach to each box. Amazon scans these when receiving.
                  </p>
                  {boxLabelsUrl ? (
                    <Button asChild className="w-full">
                      <a href={boxLabelsUrl} target="_blank" rel="noopener noreferrer">
                        <Download className="mr-2 h-4 w-4" /> Download Box Labels ({numberOfBoxes} labels)
                      </a>
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">Box labels loading...</p>
                      <Button variant="outline" onClick={fetchLabels} className="w-full">
                        <Loader2 className="mr-2 h-4 w-4" /> Retry Fetch Labels
                      </Button>
                    </div>
                  )}
                </Card>
              </div>
            )}

            <div className="flex items-center justify-between pt-4 border-t">
              <Button variant="outline" onClick={() => setStep('shipping')}>
                <ArrowLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={handleClose}>
                <CheckCircle2 className="mr-2 h-4 w-4" /> Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

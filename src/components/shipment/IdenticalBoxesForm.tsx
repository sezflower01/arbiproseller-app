import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy } from "lucide-react";
import { Product, ShipmentDraft, ShipmentJSON } from "@/types/shipment";
import { Code } from "@/components/ui/code";
import { supabase } from "@/integrations/supabase/client";

interface IdenticalBoxesFormProps {
  shipmentName: string;
  products: Product[];
  onBack: () => void;
}

const DIM_KEY = "shipment:identical:dimensions:v1";
const WEIGHT_KEY = "shipment:identical:weight:v1";
const DEFAULT_DIM = { length: 27, width: 17, height: 15, unit: 'in' as 'in' | 'cm' };
const DEFAULT_WEIGHT = { weight: 50, unit: 'lb' as 'lb' | 'kg' };

export function IdenticalBoxesForm({ shipmentName, products, onBack }: IdenticalBoxesFormProps) {
  const [numberOfBoxes, setNumberOfBoxes] = useState(1);
  const [boxQuantities, setBoxQuantities] = useState<Record<string, number[]>>(() => {
    const initial: Record<string, number[]> = {};
    products.forEach(p => {
      initial[p.id] = [0];
    });
    return initial;
  });
  const [dimensions, setDimensions] = useState(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(DIM_KEY) : null;
      return raw ? { ...DEFAULT_DIM, ...JSON.parse(raw) } : DEFAULT_DIM;
    } catch { return DEFAULT_DIM; }
  });
  const [weight, setWeight] = useState(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(WEIGHT_KEY) : null;
      return raw ? { ...DEFAULT_WEIGHT, ...JSON.parse(raw) } : DEFAULT_WEIGHT;
    } catch { return DEFAULT_WEIGHT; }
  });
  const hydratedRef = useRef(false);

  // Load defaults from DB (per-user, cross-device)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) { hydratedRef.current = true; return; }
      const { data } = await supabase
        .from("shipment_box_defaults")
        .select("length,width,height,dimension_unit,weight,weight_unit")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!cancelled && data) {
        setDimensions({
          length: Number(data.length), width: Number(data.width), height: Number(data.height),
          unit: (data.dimension_unit as 'in' | 'cm') ?? 'in',
        });
        setWeight({
          weight: Number(data.weight),
          unit: (data.weight_unit as 'lb' | 'kg') ?? 'lb',
        });
      }
      hydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist to localStorage + DB whenever values change (after hydration)
  useEffect(() => {
    try { localStorage.setItem(DIM_KEY, JSON.stringify(dimensions)); } catch {}
    try { localStorage.setItem(WEIGHT_KEY, JSON.stringify(weight)); } catch {}
    if (!hydratedRef.current) return;
    const t = setTimeout(async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      await supabase.from("shipment_box_defaults").upsert({
        user_id: user.id,
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        dimension_unit: dimensions.unit,
        weight: weight.weight,
        weight_unit: weight.unit,
      }, { onConflict: "user_id" });
    }, 600);
    return () => clearTimeout(t);
  }, [dimensions, weight]);

  const [jsonPreview, setJsonPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleNumberOfBoxesChange = (value: string) => {
    const num = parseInt(value);
    setNumberOfBoxes(num);
    
    // Reset box quantities for new number of boxes
    const newQuantities: Record<string, number[]> = {};
    products.forEach(p => {
      newQuantities[p.id] = Array(num).fill(0);
    });
    setBoxQuantities(newQuantities);
    setJsonPreview(null);
  };

  const handleBoxQuantityChange = (productId: string, boxIndex: number, value: string) => {
    const qty = parseInt(value) || 0;
    setBoxQuantities(prev => ({
      ...prev,
      [productId]: prev[productId].map((q, i) => i === boxIndex ? qty : q)
    }));
    setJsonPreview(null);
  };

  const handleCopyToAll = (productId: string) => {
    const firstBoxQty = boxQuantities[productId][0];
    setBoxQuantities(prev => ({
      ...prev,
      [productId]: Array(numberOfBoxes).fill(firstBoxQty)
    }));
  };

  const validateAndGenerateJSON = () => {
    const newErrors: Record<string, string> = {};

    // Validate products
    products.forEach(product => {
      const quantities = boxQuantities[product.id];
      
      if (numberOfBoxes === 1) {
        // For single box, qty must equal total
        if (quantities[0] !== product.totalQtyToShip) {
          newErrors[product.id] = `Units in box must equal ${product.totalQtyToShip}`;
        }
      } else {
        // For multiple boxes, all must be identical
        const firstQty = quantities[0];
        const allIdentical = quantities.every(q => q === firstQty);
        
        if (!allIdentical) {
          newErrors[product.id] = 'Each box for this product must have the same qty';
        } else {
          const totalInBoxes = firstQty * numberOfBoxes;
          if (totalInBoxes !== product.totalQtyToShip) {
            newErrors[product.id] = `Boxes × qty per box must equal ${product.totalQtyToShip} (currently ${totalInBoxes})`;
          }
        }
      }
    });

    // Validate dimensions and weight
    if (!dimensions.length || !dimensions.width || !dimensions.height) {
      newErrors.dimensions = 'All dimensions must be filled';
    }
    if (!weight.weight) {
      newErrors.weight = 'Weight must be filled';
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length > 0) {
      return;
    }

    // Generate JSON
    const shipmentJSON: ShipmentJSON = {
      shipmentId: `temp-${Date.now()}`,
      shipmentName,
      numberOfBoxes,
      boxDimensions: {
        length: dimensions.length,
        width: dimensions.width,
        height: dimensions.height,
        dimensionUnit: dimensions.unit
      },
      sourceAddress: {
        businessName: '',
        name: '',
        addressLine1: '',
        city: '',
        stateOrProvinceCode: '',
        postalCode: '',
        countryCode: 'US',
      },
      boxes: Array.from({ length: numberOfBoxes }, (_, i) => ({
        boxIndex: i + 1,
        items: products.map(p => ({
          productId: p.id,
          sku: p.sku,
          quantityInThisBox: boxQuantities[p.id][i]
        })),
        weight: weight.weight,
        weightUnit: weight.unit
      })),
      products: products.map(p => ({
        sku: p.sku,
        asin: p.asin,
        title: p.title,
        quantity: p.totalQtyToShip,
      }))
    };

    setJsonPreview(JSON.stringify(shipmentJSON, null, 2));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Configure Identical Boxes</h2>
          <p className="text-muted-foreground">
            All boxes will have identical contents, dimensions, and weight
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Shipment name: <span className="font-medium text-foreground">{shipmentName}</span>
          </p>
        </div>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      </div>

      <Card className="p-6">
        <div className="mb-6">
          <Label htmlFor="numBoxes">Number of Identical Boxes</Label>
          <Select value={numberOfBoxes.toString()} onValueChange={handleNumberOfBoxesChange}>
            <SelectTrigger id="numBoxes" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                <SelectItem key={n} value={n.toString()}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4">Product</th>
                <th className="text-left py-3 px-4 w-24">Total Qty</th>
                {numberOfBoxes === 1 ? (
                  <th className="text-left py-3 px-4 w-32">Units in Box</th>
                ) : (
                  <>
                    {Array.from({ length: numberOfBoxes }, (_, i) => (
                      <th key={i} className="text-left py-3 px-4 w-24">Box {i + 1}</th>
                    ))}
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {products.map(product => (
                <tr key={product.id} className="border-b">
                  <td className="py-3 px-4">
                    <div className="text-sm font-medium">{product.title}</div>
                    <div className="text-xs text-muted-foreground">{product.sku}</div>
                    {errors[product.id] && (
                      <div className="text-xs text-destructive mt-1">{errors[product.id]}</div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-center font-semibold">{product.totalQtyToShip}</td>
                  {numberOfBoxes === 1 ? (
                    <td className="py-3 px-4">
                      <Input
                        type="number"
                        min="0"
                        value={boxQuantities[product.id][0] || ''}
                        onChange={(e) => handleBoxQuantityChange(product.id, 0, e.target.value)}
                        className="w-24"
                      />
                    </td>
                  ) : (
                    <>
                      {Array.from({ length: numberOfBoxes }, (_, i) => (
                        <td key={i} className="py-3 px-4">
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min="0"
                              value={boxQuantities[product.id][i] || ''}
                              onChange={(e) => handleBoxQuantityChange(product.id, i, e.target.value)}
                              className="w-20"
                            />
                            {i === 0 && numberOfBoxes > 1 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleCopyToAll(product.id)}
                                title="Copy to all boxes"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      ))}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 grid md:grid-cols-2 gap-6">
          <div>
            <h3 className="font-semibold mb-4">Box Dimensions (all boxes identical)</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <Label htmlFor="length">Length</Label>
                  <Input
                    id="length"
                    type="number"
                    min="0"
                    value={dimensions.length || ''}
                    onChange={(e) => setDimensions(prev => ({ ...prev, length: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <Label htmlFor="width">Width</Label>
                  <Input
                    id="width"
                    type="number"
                    min="0"
                    value={dimensions.width || ''}
                    onChange={(e) => setDimensions(prev => ({ ...prev, width: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <Label htmlFor="height">Height</Label>
                  <Input
                    id="height"
                    type="number"
                    min="0"
                    value={dimensions.height || ''}
                    onChange={(e) => setDimensions(prev => ({ ...prev, height: parseFloat(e.target.value) || 0 }))}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="dimUnit">Unit</Label>
                <Select value={dimensions.unit} onValueChange={(v) => setDimensions(prev => ({ ...prev, unit: v as 'in' | 'cm' }))}>
                  <SelectTrigger id="dimUnit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in">inches (in)</SelectItem>
                    <SelectItem value="cm">centimeters (cm)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {errors.dimensions && (
                <div className="text-xs text-destructive">{errors.dimensions}</div>
              )}
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-4">Box Weight (all boxes identical)</h3>
            <div className="space-y-3">
              <div>
                <Label htmlFor="weight">Weight</Label>
                <Input
                  id="weight"
                  type="number"
                  min="0"
                  value={weight.weight || ''}
                  onChange={(e) => setWeight(prev => ({ ...prev, weight: parseFloat(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <Label htmlFor="weightUnit">Unit</Label>
                <Select value={weight.unit} onValueChange={(v) => setWeight(prev => ({ ...prev, unit: v as 'lb' | 'kg' }))}>
                  <SelectTrigger id="weightUnit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lb">pounds (lb)</SelectItem>
                    <SelectItem value="kg">kilograms (kg)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {errors.weight && (
                <div className="text-xs text-destructive">{errors.weight}</div>
              )}
            </div>
          </div>
        </div>
      </Card>

      <div className="flex justify-end gap-3">
        <Button onClick={validateAndGenerateJSON} size="lg">
          Preview JSON
        </Button>
      </div>

      {jsonPreview && (
        <Card className="p-6">
          <h3 className="font-semibold mb-4">Shipment Preview</h3>
          <Code>{jsonPreview}</Code>
        </Card>
      )}
    </div>
  );
}

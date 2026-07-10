import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Product } from "@/types/shipment";

interface ProductSelectionProps {
  shipmentName: string;
  onShipmentNameChange: (value: string) => void;
  onContinue: (products: Product[]) => void;
}

// Mock products for testing
const MOCK_PRODUCTS: Omit<Product, 'totalQtyToShip'>[] = [
  { id: 'p1', sku: 'P1', asin: 'B000111', title: 'Test Product 1' },
  { id: 'p2', sku: 'P2', asin: 'B000222', title: 'Test Product 2' },
  { id: 'p3', sku: 'P3', asin: 'B000333', title: 'Test Product 3' },
];

export function ProductSelection({ shipmentName, onShipmentNameChange, onContinue }: ProductSelectionProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const selectedCount = Object.values(quantities).filter((qty) => qty > 0).length;
  const canContinue = shipmentName.trim().length > 0 && selectedCount > 0;

  const handleQuantityChange = (productId: string, value: string) => {
    const qty = parseInt(value) || 0;
    setQuantities(prev => ({ ...prev, [productId]: qty }));
  };

  const handleContinue = () => {
    const products: Product[] = MOCK_PRODUCTS.map(p => ({
      ...p,
      totalQtyToShip: quantities[p.id] || 0,
    })).filter(p => p.totalQtyToShip > 0);

    if (products.length === 0) {
      alert('Please enter quantities for at least one product');
      return;
    }

    onContinue(products);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Select Products to Ship</h2>
        <p className="text-muted-foreground">
          Enter how many units of each product you want to send to Amazon FBA
        </p>
      </div>

      <Card className="p-6 space-y-4">
        <div className="space-y-2">
          <label htmlFor="shipmentName" className="text-sm font-medium">Shipment name</label>
          <Input
            id="shipmentName"
            value={shipmentName}
            onChange={(e) => onShipmentNameChange(e.target.value)}
            placeholder="e.g. May Restock Batch 01"
            className="max-w-xl"
          />
        </div>

        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Start by naming the shipment, then enter a quantity for at least one SKU to continue.
        </div>

        <div className="space-y-3 md:hidden">
          {MOCK_PRODUCTS.map((product) => (
            <div key={product.id} className="rounded-lg border p-4 space-y-3">
              <div>
                <div className="font-medium">{product.title}</div>
                <div className="text-xs text-muted-foreground">SKU: {product.sku}</div>
                <div className="text-xs text-muted-foreground">ASIN: {product.asin}</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Total Qty to Ship</div>
                <Input
                  type="number"
                  min="0"
                  inputMode="numeric"
                  value={quantities[product.id] || ''}
                  onChange={(e) => handleQuantityChange(product.id, e.target.value)}
                  placeholder="0"
                  className="w-full"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b">
                <th className="text-left py-3 px-4">SKU</th>
                <th className="text-left py-3 px-4">ASIN</th>
                <th className="text-left py-3 px-4">Title</th>
                <th className="text-left py-3 px-4 w-40">Total Qty to Ship</th>
              </tr>
            </thead>
            <tbody>
              {MOCK_PRODUCTS.map(product => (
                <tr key={product.id} className="border-b">
                  <td className="py-3 px-4 font-mono text-sm">{product.sku}</td>
                  <td className="py-3 px-4 font-mono text-sm">{product.asin}</td>
                  <td className="py-3 px-4">{product.title}</td>
                  <td className="py-3 px-4">
                    <Input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={quantities[product.id] || ''}
                      onChange={(e) => handleQuantityChange(product.id, e.target.value)}
                      placeholder="0"
                      className="w-28"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div className="rounded-lg border bg-background/95 p-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Button onClick={handleContinue} size="lg" disabled={!canContinue}>
            Continue to Boxes
          </Button>
        </div>
      </div>
    </div>
  );
}

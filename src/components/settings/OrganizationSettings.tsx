import { useState, useEffect, useRef } from "react";
import { Building2, Upload, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface OrgData {
  organization_name: string;
  address: string;
  tax_id: string;
  phone_number: string;
  logo_url: string;
}

const EMPTY: OrgData = { organization_name: "", address: "", tax_id: "", phone_number: "", logo_url: "" };

export default function OrganizationSettings() {
  const { user } = useAuth();
  const [data, setData] = useState<OrgData>(EMPTY);
  const [saved, setSaved] = useState<OrgData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: row } = await supabase
        .from("organization_settings")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (row) {
        const d: OrgData = {
          organization_name: row.organization_name || "",
          address: row.address || "",
          tax_id: row.tax_id || "",
          phone_number: row.phone_number || "",
          logo_url: row.logo_url || "",
        };
        setData(d);
        setSaved(d);
      }
      setLoading(false);
    })();
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    const payload = {
      user_id: user.id,
      organization_name: data.organization_name.trim() || null,
      address: data.address.trim() || null,
      tax_id: data.tax_id.trim() || null,
      phone_number: data.phone_number.trim() || null,
      logo_url: data.logo_url || null,
    };
    const { error } = await supabase
      .from("organization_settings")
      .upsert(payload, { onConflict: "user_id" });
    if (error) {
      toast.error("Failed to save organization settings");
      console.error(error);
    } else {
      const d = { ...data };
      setSaved(d);
      toast.success("Organization settings saved");
    }
    setSaving(false);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10 MB");
      return;
    }
    if (!["image/png", "image/jpeg"].includes(file.type)) {
      toast.error("Only PNG and JPG files are supported");
      return;
    }
    setUploading(true);
    const ext = file.name.split(".").pop();
    const path = `${user.id}/logo.${ext}`;
    const { error } = await supabase.storage.from("org-logos").upload(path, file, { upsert: true });
    if (error) {
      toast.error("Failed to upload logo");
      console.error(error);
      setUploading(false);
      return;
    }
    const { data: urlData } = supabase.storage.from("org-logos").getPublicUrl(path);
    setData((p) => ({ ...p, logo_url: urlData.publicUrl }));
    setUploading(false);
    toast.success("Logo uploaded");
  };

  const removeLogo = () => setData((p) => ({ ...p, logo_url: "" }));

  const hasChanges = JSON.stringify(data) !== JSON.stringify(saved);

  const renderField = (label: string, field: keyof OrgData, placeholder: string) => (
    <div key={field} className="flex items-center justify-between py-3 border-b border-white/10 last:border-0">
      <div>
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="text-xs text-gray-400 mt-0.5">{data[field] || "Not set"}</p>
      </div>
      <Input
        value={data[field]}
        onChange={(e) => setData((p) => ({ ...p, [field]: e.target.value }))}
        placeholder={placeholder}
        className="max-w-[260px] bg-white/5 border-white/10 text-white text-sm placeholder:text-gray-500"
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="h-5 w-5 text-blue-400" />
          <h2 className="text-lg font-bold text-white">Organization Settings</h2>
        </div>
        <p className="text-sm text-gray-400">Manage your organization details.</p>
      </div>

      <div className="rounded-xl border border-white/10 bg-[#0f1c3f] backdrop-blur-sm">
        {loading ? (
          <div className="p-6 text-center text-sm text-gray-400">Loading...</div>
        ) : (
          <div className="px-5 py-2">
            {renderField("Organization Name", "organization_name", "Enter name")}
            {renderField("Address", "address", "Enter address")}
            {renderField("Tax ID", "tax_id", "Enter tax ID")}
            {renderField("Phone Number", "phone_number", "Enter phone")}
          </div>
        )}
      </div>

      {/* Brand Logo */}
      <div className="rounded-xl border border-white/10 bg-[#0f1c3f] backdrop-blur-sm p-5">
        <h3 className="text-sm font-bold text-white mb-1">Brand Logo</h3>
        <p className="text-xs text-gray-400 mb-4">
          Personalize your account with your organization logo. Your organization logo will appear on all products in your subscription.
        </p>
        <p className="text-xs text-gray-500 mb-4">We support PNG's & JPG's under 10 MB</p>

        {data.logo_url ? (
          <div className="flex items-center gap-4">
            <img src={data.logo_url} alt="Organization logo" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
            <Button variant="ghost" size="sm" onClick={removeLogo} className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
              <X className="h-4 w-4 mr-1" /> Remove
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="border-white/20 bg-blue-600 text-white hover:bg-blue-700"
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {uploading ? "Uploading..." : "Upload Logo"}
          </Button>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleLogoUpload} />
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!hasChanges || saving} size="sm">
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

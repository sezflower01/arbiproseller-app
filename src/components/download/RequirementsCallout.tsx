import React from "react";
import { AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const RequirementsCallout = () => {
  const { t } = useLanguage();

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 max-w-3xl mx-auto mb-8">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-amber-600 mt-1 flex-shrink-0" size={20} />
        <div>
          <h3 className="font-semibold text-amber-800 mb-2">
            System Requirements
          </h3>
          <div className="text-amber-700 space-y-2">
            <p><strong>Operating System:</strong> Windows 10/11 (64-bit)</p>
            <p><strong>Framework:</strong> .NET Framework 4.7.2 or higher</p>
            <p><strong>Storage:</strong> USB drive required (must stay connected)</p>
            <p><strong>Browsers:</strong> Firefox (recommended) + Chrome</p>
            <p><strong>Account:</strong> Gmail account required</p>
            <p className="text-sm mt-3 italic">
              ⚠️ Please verify your system meets these requirements before downloading.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RequirementsCallout;

import React from "react";
import { Code } from "@/components/ui/code";
import { MonitorDown, Database, Shield, FolderOpen, FileText, HardDrive } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const InstructionSection = () => {
  const { t } = useLanguage();

  return (
    <section className="py-16 bg-white" id="instructions">
      <div className="container mx-auto px-4">
        <h3 className="text-xl font-bold mb-4 flex items-center gap-2 bg-gradient-to-r from-blue-800 to-blue-600 bg-clip-text text-transparent">
          <Database size={18} /> {t('instruction_section.title')}
        </h3>
        
        <div className="max-w-3xl mx-auto">
          <div className="mt-10 pt-6 border-t border-gray-100">
            <div className="bg-blue-50 p-6 rounded-lg border-l-4 border-blue-500">
              <div className="prose prose-slate max-w-none">
                <p className="mb-4 text-blue-900">
                  {t('instruction_section.description')}
                </p>
                <ul className="list-disc ml-6 space-y-2 text-blue-800">
                  <li>{t('instruction_section.item1')}</li>
                  <li>{t('instruction_section.item2')}</li>
                  <li>{t('instruction_section.item3')}</li>
                  <li>{t('instruction_section.item4')}</li>
                </ul>
                <p className="mt-4 text-blue-900">
                  {t('instruction_section.storage_description')}
                </p>
                <p className="mt-4 flex items-start gap-2 text-blue-900">
                  <Shield size={18} className="text-green-600 flex-shrink-0 mt-1" />
                  <span>
                    {t('instruction_section.systematic_approach')}
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default InstructionSection;

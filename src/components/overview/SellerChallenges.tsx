
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useLanguage } from '@/contexts/LanguageContext';

// The icon image replaces all the Lucide icons
const ICON_SRC = '/logo-icon.png';

const SellerChallenges = () => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Left column - Common Seller Challenges */}
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 p-5 rounded-lg border border-purple-100">
          <h3 className="text-2xl font-bold mb-6">{t('overview.challenges_title')}</h3>
          <div className="space-y-5">
            {[
              {
                title: t('overview.challenge1_title'),
                desc: t('overview.challenge1_description')
              },
              {
                title: t('overview.challenge2_title'),
                desc: t('overview.challenge2_description')
              },
              {
                title: t('overview.challenge3_title'),
                desc: t('overview.challenge3_description')
              },
              {
                title: t('overview.challenge4_title'),
                desc: t('overview.challenge4_description')
              },
              {
                title: t('overview.built_in_accuracy_title'),
                desc: (
                  <>
                    {t('overview.built_in_accuracy_description')}
                    <ul className="mt-1 ml-4 text-gray-700 text-sm list-disc">
                      <li>{t('overview.accuracy_benefit1')}</li>
                      <li>{t('overview.accuracy_benefit2')}</li>
                    </ul>
                  </>
                )
              }
            ].map((item, idx) => (
              <div className="flex items-start" key={idx}>
                <div className="bg-purple-100 p-2 rounded-full mr-4 flex items-center justify-center w-8 h-8">
                  <img src={ICON_SRC} alt="" className="w-6 h-6 object-contain" draggable={false} />
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900">{item.title}</h4>
                  <p className="text-gray-700 text-sm">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right column - Build Amazon Replenishment Shipments */}
        <div className="bg-gradient-to-r from-purple-50 to-indigo-50 p-5 rounded-lg border border-purple-100">
          <h3 className="text-2xl font-bold mb-4">{t('overview.shipment_builder_title')}</h3>
          <p className="text-gray-700 mb-3">
            {t('overview.shipment_builder_description')}
          </p>
          
          <div className="space-y-3">
            <div>
              <h5 className="font-semibold text-gray-900 text-sm">{t('overview.how_it_works_title')}</h5>
              <ul className="ml-4 text-gray-700 text-sm list-disc">
                <li>{t('overview.how_it_works_1')}</li>
                <li>{t('overview.how_it_works_2')}</li>
                <li>{t('overview.how_it_works_3')}</li>
              </ul>
            </div>
            
            <div>
              <h5 className="font-semibold text-gray-900 text-sm">{t('overview.flexibility_title')}</h5>
              <ul className="ml-4 text-gray-700 text-sm list-disc">
                <li>{t('overview.flexibility_1')}</li>
                <li>{t('overview.flexibility_2')}</li>
                <li>{t('overview.flexibility_3')}</li>
              </ul>
            </div>
            
            <div>
              <h5 className="font-semibold text-gray-900 text-sm">{t('overview.shipment_value_title')}</h5>
              <ul className="ml-4 text-gray-700 text-sm list-disc">
                <li>{t('overview.shipment_value_1')}</li>
                <li>{t('overview.shipment_value_2')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Image below both blocks */}
      <div className="flex justify-center">
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <img 
              src="/lovable-uploads/b3c3f94a-b4f7-4139-9abb-f9d17223d3d7.png" 
              alt="Inventory S.P.R.I.N.T. Dashboard Interface"
              className="w-full max-w-4xl h-auto rounded-lg shadow-lg cursor-zoom-in border border-gray-200"
            />
          </DialogTrigger>
          <DialogContent className="max-w-[95vw] w-full p-0 bg-transparent border-none">
            <img 
              src="/lovable-uploads/b3c3f94a-b4f7-4139-9abb-f9d17223d3d7.png" 
              alt="Inventory S.P.R.I.N.T. Dashboard Interface (Zoomed)"
              className="w-full h-auto max-h-[95vh] object-contain"
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default SellerChallenges;

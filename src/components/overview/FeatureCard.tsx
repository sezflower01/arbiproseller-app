
import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

interface FeatureCardProps {
  title: string;
  description: string;
  color: string;
}

const ICON_SRC = '/lovable-uploads/730b8167-471d-4034-a4db-41a9eaa3a4af.png';

const FeatureCard = ({ title, description, color }: FeatureCardProps) => {
  return (
    <Card className="group border border-brand-100 hover:border-brand-300 hover:shadow-lg transition-all duration-300 bg-gradient-to-br from-white to-brand-50/30">
      <CardContent className="p-6">
        <div className={`${color} p-3 rounded-full w-12 h-12 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300`}>
          <img
            src={ICON_SRC}
            alt=""
            className="w-8 h-8 object-contain"
            draggable={false}
          />
        </div>
        <h4 className="text-xl font-bold mb-3 bg-gradient-to-r from-brand-800 to-brand-600 bg-clip-text text-transparent group-hover:from-brand-900 group-hover:to-brand-700 transition-all">
          {title}
        </h4>
        <p className="text-gray-600 group-hover:text-brand-700 transition-colors leading-relaxed">
          {description}
        </p>
      </CardContent>
    </Card>
  );
};

export default FeatureCard;

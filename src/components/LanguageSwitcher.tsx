
import React from 'react';
import { Globe } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useLanguage } from '@/contexts/LanguageContext';

const LanguageSwitcher = () => {
  const { language, setLanguage } = useLanguage();

  const languages = [
    { code: 'en', name: 'English', flag: '🇺🇸', variant: 'us' },
    { code: 'es', name: 'Español', flag: '🇪🇸', variant: 'es' }
  ];

  // Get current language preference (including variant)
  const currentLanguageKey = localStorage.getItem('selectedLanguageVariant') || 'en-us';
  console.log('Current language key from localStorage:', currentLanguageKey);
  
  const currentLanguage = languages.find(lang => {
    const key = lang.variant ? `${lang.code}-${lang.variant}` : lang.code;
    return key === currentLanguageKey;
  }) || languages[0];

  console.log('Current language object:', currentLanguage);

  const handleLanguageChange = (lang: typeof languages[0]) => {
    const languageKey = lang.variant ? `${lang.code}-${lang.variant}` : lang.code;
    console.log('Setting language variant to:', languageKey);
    localStorage.setItem('selectedLanguageVariant', languageKey);
    setLanguage(lang.code as 'en' | 'es');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="flex items-center gap-2">
          <Globe size={16} />
          <span className="text-lg">{currentLanguage?.flag}</span>
          <span className="hidden sm:inline">{currentLanguage?.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="bg-white border border-gray-200 rounded-md shadow-md z-50">
        {languages.map((lang, index) => {
          const languageKey = lang.variant ? `${lang.code}-${lang.variant}` : lang.code;
          const isActive = languageKey === currentLanguageKey;
          
          return (
            <DropdownMenuItem
              key={`${lang.code}-${lang.variant || index}`}
              onClick={() => handleLanguageChange(lang)}
              className={`flex items-center gap-2 cursor-pointer hover:bg-gray-50 ${
                isActive ? 'bg-blue-50 text-blue-700' : ''
              }`}
            >
              <span className="text-lg">{lang.flag}</span>
              <span>{lang.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default LanguageSwitcher;

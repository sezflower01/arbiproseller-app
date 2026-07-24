import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { fetchGeoInfo } from '@/hooks/use-geo-tracking';

type Language = 'en' | 'es';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isLoading: boolean;
  isUSAUser: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

interface LanguageProviderProps {
  children: ReactNode;
}

// English-speaking countries
const ENGLISH_SPEAKING_COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Australia', 'New Zealand',
  'Ireland', 'South Africa', 'Jamaica', 'Trinidad and Tobago', 'Barbados',
  'Malta', 'Cyprus', 'Singapore', 'Hong Kong', 'India', 'Pakistan',
  'Nigeria', 'Ghana', 'Kenya', 'Uganda', 'Tanzania', 'Zimbabwe', 'Botswana'
];

// Spanish-speaking countries
const SPANISH_SPEAKING_COUNTRIES = [
  'Spain', 'Mexico', 'Argentina', 'Colombia', 'Peru', 'Venezuela', 'Chile', 
  'Ecuador', 'Guatemala', 'Cuba', 'Bolivia', 'Dominican Republic', 'Honduras', 
  'Paraguay', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Uruguay',
  'Puerto Rico', 'Equatorial Guinea'
];

export const LanguageProvider: React.FC<LanguageProviderProps> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en');
  const [translations, setTranslations] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isUSAUser, setIsUSAUser] = useState(false);

  // Initialize language based on saved preference or geo location
  useEffect(() => {
    const initializeLanguage = async () => {
      setIsLoading(true);
      
      // Check for any saved language preference first (including variants)
      const savedLanguage = localStorage.getItem('preferredLanguage') as Language;
      const savedLanguageVariant = localStorage.getItem('selectedLanguageVariant');
      
      console.log('LanguageContext - Saved language:', savedLanguage);
      console.log('LanguageContext - Saved variant:', savedLanguageVariant);
      
      // Always fetch geo info to determine if user is in USA
      try {
        const geoInfo = await fetchGeoInfo();
        const userInUSA = geoInfo.country === 'United States';
        setIsUSAUser(userInUSA);
        console.log('User is in USA:', userInUSA);
        
        // If we have ANY saved preference (language or variant), use it
        if (savedLanguage && ['en', 'es'].includes(savedLanguage)) {
          console.log('Using saved language preference:', savedLanguage);
          setLanguageState(savedLanguage);
          setIsInitialized(true);
        } else if (savedLanguageVariant) {
          // If we have a variant saved, extract the language code and treat it as a user preference
          const languageFromVariant = savedLanguageVariant.split('-')[0] as Language;
          if (['en', 'es'].includes(languageFromVariant)) {
            console.log('Using language from saved variant (user preference):', languageFromVariant);
            setLanguageState(languageFromVariant);
            // Save as preferred language to prevent future geo-detection
            localStorage.setItem('preferredLanguage', languageFromVariant);
            setIsInitialized(true);
          }
        } else {
          // No saved preference at all, detect based on geography
          if (geoInfo.country) {
            // Spain - set Spanish with Spain variant
            if (geoInfo.country === 'Spain') {
              console.log('Setting Spanish (Spain) based on detected country:', geoInfo.country);
              setLanguageState('es');
              localStorage.setItem('preferredLanguage', 'es');
              localStorage.setItem('selectedLanguageVariant', 'es-es');
            }
            // Other Spanish-speaking countries
            else if (SPANISH_SPEAKING_COUNTRIES.includes(geoInfo.country)) {
              console.log('Setting Spanish based on detected country:', geoInfo.country);
              setLanguageState('es');
              localStorage.setItem('preferredLanguage', 'es');
              localStorage.setItem('selectedLanguageVariant', 'es-es');
            }
            // Default to English (US) for all other countries
            else {
              console.log('Setting English (US) based on detected country:', geoInfo.country);
              setLanguageState('en');
              localStorage.setItem('preferredLanguage', 'en');
              localStorage.setItem('selectedLanguageVariant', 'en-us');
            }
          } else {
            console.log('No country detected, defaulting to English');
            setLanguageState('en');
            localStorage.setItem('preferredLanguage', 'en');
            localStorage.setItem('selectedLanguageVariant', 'en-us');
          }
          setIsInitialized(true);
        }
      } catch (error) {
        console.error('Error detecting location, defaulting to English:', error);
        setLanguageState('en');
        localStorage.setItem('preferredLanguage', 'en');
        localStorage.setItem('selectedLanguageVariant', 'en-us');
        setIsUSAUser(false); // Default to false if geo detection fails
        setIsInitialized(true);
      }
    };

    initializeLanguage();
  }, []);

  // Load translations when language changes
  useEffect(() => {
    if (!isInitialized) return;
    
    const loadTranslations = async () => {
      try {
        // Bundled import — works identically in dev and production. (A prior
        // version tried `fetch('/src/locales/...')` first: that path is only
        // ever served in dev; in production it hits the SPA fallback route,
        // which returns index.html — response.json() then throws "Unexpected
        // token '<'" trying to parse HTML as JSON, on every single page load.)
        const translations = await import(`../locales/${language}.json`);
        setTranslations(translations.default);
      } catch (error) {
        console.error('Error loading translations:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTranslations();
  }, [language, isInitialized]);

  const setLanguage = (lang: Language) => {
    console.log('LanguageContext - Manually setting language to:', lang);
    setLanguageState(lang);
    localStorage.setItem('preferredLanguage', lang);
    // Don't override the selectedLanguageVariant here - let the switcher handle it
  };

  // Translation function
  const t = (key: string): string => {
    if (isLoading || !isInitialized) {
      return ''; // Return empty string while loading to prevent flash
    }
    
    const keys = key.split('.');
    let value = translations;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        console.warn(`Translation key not found: ${key}`);
        return key; // Return the key itself if translation is not found
      }
    }
    
    return typeof value === 'string' ? value : key;
  };

  // Don't render children until language is initialized and translations are loaded
  if (isLoading || !isInitialized) {
    return (
      <div style={{ minHeight: '100vh', backgroundColor: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ 
            width: '32px', 
            height: '32px', 
            border: '2px solid #2563eb', 
            borderTopColor: 'transparent', 
            borderRadius: '50%', 
            animation: 'spin 1s linear infinite',
            margin: '0 auto 16px'
          }}></div>
          <p style={{ color: '#2563eb', fontWeight: 500 }}>Loading...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, isLoading, isUSAUser }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

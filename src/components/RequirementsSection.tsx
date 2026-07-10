
import React from "react";
import { Monitor, Globe, X, Mail, Download, UsbIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/LanguageContext";

const RequirementsSection = () => {
  const { t } = useLanguage();

  const handleFirefoxDownload = () => {
    console.log("Starting Firefox download...");
    const firefoxUrl = "https://mstibdszibcheodvnprm.supabase.co/storage/v1/object/sign/access/Firefox%20Installer.exe?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV9iODE0YWYxZi1jYzk3LTQ2MTAtOTc1ZC03ZjY4YWMxNGY1MjQiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhY2Nlc3MvRmlyZWZveCBJbnN0YWxsZXIuZXhlIiwiaWF0IjoxNzQ5ODY1MzUyLCJleHAiOjIwNjUyMjUzNTJ9.8B5SDw7hXiRFK2OnCoC1npYJfY-98P4aj_BXJcZd69w";
    
    const link = document.createElement('a');
    link.href = firefoxUrl;
    link.download = "Firefox Installer.exe";
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleChromeDownload = () => {
    console.log("Starting Chrome download...");
    const chromeUrl = "https://mstibdszibcheodvnprm.supabase.co/storage/v1/object/sign/access/ChromeSetup.exe?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV9iODE0YWYxZi1jYzk3LTQ2MTAtOTc1ZC03ZjY4YWMxNGY1MjQiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhY2Nlc3MvQ2hyb21lU2V0dXAuZXhlIiwiaWF0IjoxNzQ5ODY1NjE4LCJleHAiOjIwNjUyMjU2MTh9.BfOsxaokcqEqRx1dUW-ZtpkK5BNbraB2XOK7HVD5uhM";
    
    const link = document.createElement('a');
    link.href = chromeUrl;
    link.download = "ChromeSetup.exe";
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const requirements = [
    {
      title: t("requirements.operating_system_title"),
      description: t("requirements.operating_system_description"),
      icon: Globe,
      critical: true
    },
    {
      title: t("requirements.internet_connection_title"),
      description: t("requirements.internet_connection_description"),
      icon: Globe,
      critical: true
    },
    {
      title: t("requirements.usb_drive_title"),
      description: t("requirements.usb_drive_description"),
      icon: UsbIcon,
      critical: true,
      warningClass: "border-purple-500 bg-purple-50 text-purple-900"
    },
    {
      title: t("requirements.gmail_requirement_title"),
      description: `${t("requirements.gmail_requirement_description")}\n\n${t("requirements.gmail_warning")}`,
      icon: Mail,
      critical: true,
      warningClass: "border-blue-500 bg-blue-50 text-blue-900"
    },
    {
      title: t("requirements.firefox_title"),
      description: `${t("requirements.firefox_description")}\n\n${t("requirements.firefox_recommendation")}`,
      icon: Globe,
      critical: true,
      hasDownload: true,
      downloadHandler: handleFirefoxDownload,
      buttonText: t("requirements.download_firefox"),
      warningClass: "border-orange-500 bg-orange-50 text-orange-900"
    },
    {
      title: t("requirements.chrome_title"),
      description: `${t("requirements.chrome_description")}\n\n${t("requirements.chrome_recommendation")}`,
      icon: Globe,
      critical: true,
      hasDownload: true,
      downloadHandler: handleChromeDownload,
      buttonText: t("requirements.download_chrome"),
      warningClass: "border-green-500 bg-green-50 text-green-900"
    }
  ];

  return (
    <section className="py-16 bg-gray-50" id="requirements">
      <div className="container mx-auto px-4">
        <h2 className="text-3xl font-bold mb-8 text-center">
          {t("requirements.title")}
        </h2>
        
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
            {requirements.map((req, index) => (
              <div 
                key={index} 
                className={`
                  ${req.warningClass || "bg-white"}
                  p-6 rounded-xl shadow-sm hover:shadow-md transition-shadow
                `}
              >
                <div className="flex items-center mb-4">
                  <span className={`
                    h-8 w-8 rounded-full flex items-center justify-center mr-3
                    ${req.title === t("requirements.usb_drive_title")
                      ? "bg-purple-100"
                      : req.title === t("requirements.gmail_requirement_title")
                      ? "bg-blue-100"
                      : req.title === t("requirements.firefox_title")
                      ? "bg-orange-100"
                      : req.title === t("requirements.chrome_title")
                      ? "bg-green-100"
                      : "bg-green-100"}
                  `}>
                    <req.icon className={`h-5 w-5 ${
                      req.title === t("requirements.usb_drive_title")
                        ? "text-purple-600"
                        : req.title === t("requirements.gmail_requirement_title")
                        ? "text-blue-600"
                        : req.title === t("requirements.firefox_title")
                        ? "text-orange-600"
                        : req.title === t("requirements.chrome_title")
                        ? "text-green-600"
                        : "text-green-600"
                    }`} />
                  </span>
                  <h3 className="font-semibold text-xl">{req.title}</h3>
                </div>
                <p className="text-gray-600 whitespace-pre-line mb-4">{req.description}</p>
                
                {req.hasDownload && (
                  <div className="flex justify-start pl-2">
                    <Button 
                      onClick={req.downloadHandler}
                      className={`text-white text-xs px-6 py-4 min-h-[48px] ${
                        req.title === t("requirements.firefox_title")
                          ? "bg-orange-600 hover:bg-orange-700"
                          : "bg-green-600 hover:bg-green-700"
                      }`}
                      size="sm"
                    >
                      <Download className="mr-2 h-4 w-4 flex-shrink-0" />
                      <span className="whitespace-nowrap">{req.buttonText}</span>
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default RequirementsSection;

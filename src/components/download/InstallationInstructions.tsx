
import React from "react";
import { FileDown, Info } from "lucide-react";

const InstallationInstructions = () => {
  return (
    <div className="mt-8 p-4 bg-blue-50 border-l-4 border-blue-500 rounded max-w-3xl mx-auto text-left">
      <p className="text-blue-800 flex items-center">
        <Info className="mr-2" size={18} />
        <span className="font-bold">Installation Instructions:</span>
      </p>
      <ol className="mt-2 ml-4 list-decimal text-blue-800">
        <li>Download the Setup_ArbiProSellerNoAPI.exe installer</li>
        <li>Run the installer as Administrator</li>
        <li>Follow the installation wizard steps</li>
        <li>Launch ArbiProSeller from your desktop or start menu</li>
      </ol>
      <div className="mt-4 pt-4 border-t border-blue-200">
        <p className="text-blue-800">
          <span className="font-bold">Important Notes:</span>
        </p>
        <ul className="mt-2 ml-4 list-disc text-blue-800">
          <li>The installer file will be downloaded to your default downloads folder</li>
          <li>If Windows SmartScreen appears, click "More info" then "Run anyway"</li>
          <li>The installer will create a desktop shortcut automatically</li>
          <li>All required dependencies will be installed automatically</li>
        </ul>
      </div>
    </div>
  );
};

export default InstallationInstructions;


/**
 * Utility to clean XML files by ensuring XML declaration is at the start
 * Note: This is meant to be used in a Node.js environment, not in the browser
 */

import fs from 'fs';
import path from 'path';

/**
 * Cleans an XML file by removing any whitespace before the XML declaration
 * @param filePath Path to the XML file
 * @returns boolean indicating success
 */
export const cleanXmlFile = (filePath: string): boolean => {
  try {
    // Read the file
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Check if it starts with XML declaration
    if (content.trim().startsWith('<?xml')) {
      // If there's whitespace before the declaration, remove it
      if (!content.startsWith('<?xml')) {
        const cleanedContent = content.trim();
        fs.writeFileSync(filePath, cleanedContent);
        console.log(`Cleaned XML file: ${filePath}`);
      }
      return true;
    } else {
      console.warn(`File ${filePath} does not start with XML declaration`);
      return false;
    }
  } catch (error) {
    console.error(`Error cleaning XML file ${filePath}:`, error);
    return false;
  }
};

/**
 * Scans a directory for XML files and cleans them
 * @param directoryPath Path to the directory to scan
 */
export const cleanAllXmlFiles = (directoryPath: string): void => {
  try {
    const files = fs.readdirSync(directoryPath);
    
    files.forEach(file => {
      const filePath = path.join(directoryPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        // Recursively scan subdirectories
        cleanAllXmlFiles(filePath);
      } else if (file.endsWith('.xml')) {
        cleanXmlFile(filePath);
      }
    });
    
    console.log(`Finished scanning ${directoryPath} for XML files`);
  } catch (error) {
    console.error(`Error scanning directory ${directoryPath}:`, error);
  }
};

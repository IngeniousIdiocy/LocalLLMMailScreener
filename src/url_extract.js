/**
 * URL extraction and analysis for phishing detection.
 * Extracts URLs from email bodies, checks for IP-based URLs and display/href mismatches.
 */

/**
 * Check if a URL uses an IP address instead of a domain name.
 * Legitimate services NEVER send links to raw IPs - this is a strong phishing indicator.
 * @param {string} url - The URL to check
 * @returns {Object} { is_ip_based: boolean, ip_type: string|null }
 */
export const checkIpBasedUrl = (url) => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    
    // IPv6 in brackets: [::1] or [0000:0000:...] or [::ffff:192.168.1.1]
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return { is_ip_based: true, ip_type: 'ipv6' };
    }
    
    // IPv4: four octets like 192.168.1.1
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(hostname)) {
      // Validate each octet is 0-255
      const octets = hostname.split('.').map(Number);
      if (octets.every(n => n >= 0 && n <= 255)) {
        return { is_ip_based: true, ip_type: 'ipv4' };
      }
    }
    
    // Decimal IP: single large integer like 3232235777 (= 192.168.1.1)
    // These are rare but used by some phishing attacks
    const decimalIpRegex = /^\d{8,10}$/;
    if (decimalIpRegex.test(hostname)) {
      const num = parseInt(hostname, 10);
      // Valid IPv4 range: 0 to 4294967295 (2^32 - 1)
      if (num >= 0 && num <= 4294967295) {
        return { is_ip_based: true, ip_type: 'decimal_ip' };
      }
    }
    
    return { is_ip_based: false, ip_type: null };
  } catch {
    return { is_ip_based: false, ip_type: null };
  }
};

/**
 * Extract the root domain from a URL (e.g., "mail.google.com" -> "google.com")
 * Handles subdomains and common TLDs.
 */
export const extractRootDomain = (url) => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    // Common multi-part TLDs (this is a technical standard, not a whitelist)
    const multiPartTlds = [
      'co.uk', 'co.nz', 'co.jp', 'co.kr', 'co.in', 'co.za',
      'com.au', 'com.br', 'com.mx', 'com.sg', 'com.hk',
      'org.uk', 'org.au', 'net.au', 'gov.uk', 'ac.uk'
    ];
    
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    
    // Check for multi-part TLD
    const lastTwo = parts.slice(-2).join('.');
    if (multiPartTlds.includes(lastTwo)) {
      return parts.slice(-3).join('.');
    }
    
    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
};

/**
 * Extract URLs from plain text (finds http/https URLs)
 * Skips URLs that appear inside HTML anchor tags (those are handled separately)
 */
const extractPlaintextUrls = (text) => {
  if (!text) return [];
  
  // First, remove all anchor tags to avoid double-counting
  const textWithoutAnchors = text.replace(/<a\s+[^>]*href\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi, ' ');
  
  // Match URLs starting with http:// or https://
  const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = textWithoutAnchors.match(urlRegex) || [];
  
  return matches.map((url) => {
    // Clean trailing punctuation that's likely not part of URL
    const cleaned = url.replace(/[.,;:!?)>\]]+$/, '');
    return {
      url: cleaned,
      root_domain: extractRootDomain(cleaned),
      display_text: null,
      mismatch: false
    };
  });
};

/**
 * Extract URLs from HTML anchor tags, capturing display text and href separately
 */
const extractHtmlLinks = (text) => {
  if (!text) return [];
  
  const results = [];
  
  // Match <a> tags with href attribute
  const anchorRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  
  let match;
  while ((match = anchorRegex.exec(text)) !== null) {
    const href = match[1];
    // Strip HTML tags from display text and normalize whitespace
    const displayText = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Only process http/https URLs
    if (href.startsWith('http://') || href.startsWith('https://')) {
      const hrefDomain = extractRootDomain(href);
      
      // Check if display text looks like a URL/domain
      const displayLooksLikeUrl = /^(https?:\/\/)?[\w.-]+\.(com|org|net|edu|gov|io|co|us|uk|ca|au|de|fr|jp|cn|ru|br|in|mx|es|it|nl|se|no|fi|dk|pl|cz|at|ch|be|pt|ie|nz|sg|hk|kr|tw|my|ph|th|vn|id|za)/.test(displayText);
      
      let mismatch = false;
      
      if (displayLooksLikeUrl) {
        // Extract domain from display text
        const displayUrl = displayText.startsWith('http') 
          ? displayText 
          : `https://${displayText}`;
        const displayDomain = extractRootDomain(displayUrl);
        
        // Flag mismatch if display domain differs from actual href domain
        if (displayDomain && hrefDomain && displayDomain !== hrefDomain) {
          mismatch = true;
        }
      }
      
      results.push({
        url: href,
        root_domain: hrefDomain,
        display_text: displayText || null,
        mismatch
      });
    }
  }
  
  return results;
};

/**
 * Deduplicate URLs by href, keeping the most informative entry
 */
const deduplicateUrls = (urls) => {
  const seen = new Map();
  
  for (const entry of urls) {
    const key = entry.url.toLowerCase();
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, entry);
    } else {
      // Prefer entries with mismatch flag set
      if (entry.mismatch && !existing.mismatch) {
        seen.set(key, entry);
      }
    }
  }
  
  return Array.from(seen.values());
};

/**
 * Main extraction function: extract and analyze all URLs from email text
 * @param {string} bodyText - The email body (can be plain text or contain HTML)
 * @returns {Object} URL analysis results (clean structure for LLM)
 */
export const extractUrls = (bodyText) => {
  if (!bodyText) {
    return {
      count: 0,
      unique_domains: [],
      has_ip_based_urls: false,
      has_mismatched_urls: false
    };
  }
  
  // Extract from both HTML and plaintext patterns
  const htmlLinks = extractHtmlLinks(bodyText);
  const plaintextUrls = extractPlaintextUrls(bodyText);
  
  // Combine and deduplicate
  const allUrls = deduplicateUrls([...htmlLinks, ...plaintextUrls]);
  
  // Check each URL for IP-based and collect domains
  const domains = new Set();
  let hasIpBasedUrls = false;
  let hasMismatchedUrls = false;
  
  for (const entry of allUrls) {
    // Collect unique root domains
    if (entry.root_domain) {
      domains.add(entry.root_domain);
    }
    
    // Check for IP-based URLs
    const ipCheck = checkIpBasedUrl(entry.url);
    if (ipCheck.is_ip_based) {
      hasIpBasedUrls = true;
      // For IP-based URLs, add the IP itself to domains list
      try {
        const hostname = new URL(entry.url).hostname;
        domains.add(hostname);
      } catch { /* ignore */ }
    }
    
    // Check for display/href mismatch
    if (entry.mismatch) {
      hasMismatchedUrls = true;
    }
  }
  
  return {
    count: allUrls.length,
    unique_domains: Array.from(domains),
    has_ip_based_urls: hasIpBasedUrls,
    has_mismatched_urls: hasMismatchedUrls
  };
};

/**
 * Analyze sender address for domain info
 * @param {string} fromHeader - The From header value
 * @returns {Object} Sender analysis
 */
export const analyzeSender = (fromHeader) => {
  if (!fromHeader) {
    return { email: null, display_name: null, domain: null, root_domain: null };
  }
  
  // Try "Display Name <email@domain.com>" format first
  const bracketMatch = fromHeader.match(/^(?:"?([^"<]*)"?\s*)?<([^<>]+@[^<>]+)>$/);
  if (bracketMatch) {
    const displayName = (bracketMatch[1] || '').trim();
    const email = bracketMatch[2];
    const domain = email.split('@')[1]?.toLowerCase() || null;
    const rootDomain = domain ? extractRootDomain(`https://${domain}`) : null;
    return {
      email,
      display_name: displayName || null,
      domain,
      root_domain: rootDomain
    };
  }
  
  // Try bare email address format
  const bareMatch = fromHeader.match(/^([^\s@]+@[^\s@]+\.[^\s@]+)$/);
  if (bareMatch) {
    const email = bareMatch[1];
    const domain = email.split('@')[1]?.toLowerCase() || null;
    const rootDomain = domain ? extractRootDomain(`https://${domain}`) : null;
    return {
      email,
      display_name: null,
      domain,
      root_domain: rootDomain
    };
  }
  
  return { email: null, display_name: fromHeader, domain: null, root_domain: null };
};

export default { extractUrls, extractRootDomain, analyzeSender, checkIpBasedUrl };

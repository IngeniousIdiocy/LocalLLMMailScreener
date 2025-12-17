process.env.NO_AUTO_START = '1';
process.env.NODE_ENV = 'test';

import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUrls, extractRootDomain, analyzeSender, checkIpBasedUrl } from '../src/url_extract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loadFixture = (filename) => fs.readFileSync(path.join(__dirname, 'fixtures', filename), 'utf8');

describe('extractRootDomain', () => {
  test('extracts root domain from simple URL', () => {
    assert.strictEqual(extractRootDomain('https://www.google.com/search'), 'google.com');
  });

  test('extracts root domain from subdomain URL', () => {
    assert.strictEqual(extractRootDomain('https://mail.google.com/inbox'), 'google.com');
  });

  test('handles multi-part TLDs like co.uk', () => {
    assert.strictEqual(extractRootDomain('https://www.example.co.uk/page'), 'example.co.uk');
  });

  test('handles multi-part TLDs like com.au', () => {
    assert.strictEqual(extractRootDomain('https://shop.example.com.au'), 'example.com.au');
  });

  test('returns null for invalid URL', () => {
    assert.strictEqual(extractRootDomain('not-a-url'), null);
  });

  test('handles URL without subdomain', () => {
    assert.strictEqual(extractRootDomain('https://example.com'), 'example.com');
  });

  test('handles deep subdomains', () => {
    assert.strictEqual(extractRootDomain('https://a.b.c.d.example.com/path'), 'example.com');
  });
});

describe('checkIpBasedUrl', () => {
  test('detects IPv4 addresses', () => {
    const result = checkIpBasedUrl('http://192.168.1.1/path');
    assert.strictEqual(result.is_ip_based, true);
    assert.strictEqual(result.ip_type, 'ipv4');
  });

  test('detects IPv6 addresses in brackets', () => {
    const result = checkIpBasedUrl('http://[0000:0000:0000:0000:0000:ffff:1769:2bd4]/path');
    assert.strictEqual(result.is_ip_based, true);
    assert.strictEqual(result.ip_type, 'ipv6');
  });

  test('detects short IPv6 addresses', () => {
    const result = checkIpBasedUrl('http://[::1]/path');
    assert.strictEqual(result.is_ip_based, true);
    assert.strictEqual(result.ip_type, 'ipv6');
  });

  test('detects decimal IP addresses (converted to IPv4 by URL parser)', () => {
    // 3232235777 = 192.168.1.1 - Node's URL parser converts this to IPv4
    const result = checkIpBasedUrl('http://3232235777/path');
    assert.strictEqual(result.is_ip_based, true);
    // Node.js URL parser normalizes decimal IPs to IPv4 format
    assert.strictEqual(result.ip_type, 'ipv4');
  });

  test('does NOT flag normal domains', () => {
    const result = checkIpBasedUrl('https://www.google.com/path');
    assert.strictEqual(result.is_ip_based, false);
    assert.strictEqual(result.ip_type, null);
  });

  test('does NOT flag domains that look like IPs', () => {
    // 192.com is a domain, not an IP
    const result = checkIpBasedUrl('https://192.com/path');
    assert.strictEqual(result.is_ip_based, false);
  });

  test('handles invalid URLs gracefully', () => {
    const result = checkIpBasedUrl('not-a-url');
    assert.strictEqual(result.is_ip_based, false);
    assert.strictEqual(result.ip_type, null);
  });
});

describe('extractUrls', () => {
  test('returns empty result for null input', () => {
    const result = extractUrls(null);
    assert.strictEqual(result.count, 0);
    assert.deepStrictEqual(result.unique_domains, []);
    assert.strictEqual(result.has_mismatched_urls, false);
    assert.strictEqual(result.has_ip_based_urls, false);
  });

  test('extracts plaintext URLs and returns domain', () => {
    const body = 'Check out https://example.com/page for more info.';
    const result = extractUrls(body);
    assert.strictEqual(result.count, 1);
    assert.ok(result.unique_domains.includes('example.com'));
  });

  test('extracts HTML anchor with matching display/href', () => {
    const body = '<a href="https://paypal.com/login">https://paypal.com/login</a>';
    const result = extractUrls(body);
    assert.strictEqual(result.count, 1);
    assert.ok(result.unique_domains.includes('paypal.com'));
    assert.strictEqual(result.has_mismatched_urls, false);
  });

  test('detects mismatched display text vs href', () => {
    const body = '<a href="https://paypal.scammer.ru/steal">https://paypal.com/secure</a>';
    const result = extractUrls(body);
    assert.strictEqual(result.count, 1);
    assert.ok(result.unique_domains.includes('scammer.ru'));
    assert.strictEqual(result.has_mismatched_urls, true);
  });

  test('handles multiple URLs and returns unique domains', () => {
    const body = `
      <a href="https://google.com/search">Google Search</a>
      <a href="https://paypal.evil.net/steal">https://paypal.com/secure</a>
      Visit https://example.com for more.
    `;
    const result = extractUrls(body);
    assert.ok(result.count >= 2);
    assert.ok(result.unique_domains.includes('google.com'));
    assert.ok(result.unique_domains.includes('evil.net'));
    assert.strictEqual(result.has_mismatched_urls, true);
  });

  test('deduplicates URLs by href', () => {
    const body = `
      <a href="https://example.com/page">Click here</a>
      Also see https://example.com/page for details.
    `;
    const result = extractUrls(body);
    // Should dedupe to just one entry
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.unique_domains.length, 1);
    assert.ok(result.unique_domains.includes('example.com'));
  });

  test('handles anchor tags with non-URL display text', () => {
    const body = '<a href="https://legitimate-bank.com/login">Click here to login</a>';
    const result = extractUrls(body);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.has_mismatched_urls, false); // display text doesn't look like a URL
  });

  test('detects IP-based URLs and includes IP in domains', () => {
    const body = 'Click here: http://192.168.1.100/login.php';
    const result = extractUrls(body);
    assert.strictEqual(result.has_ip_based_urls, true);
    assert.ok(result.unique_domains.includes('192.168.1.100'));
  });
});

describe('analyzeSender', () => {
  test('parses standard email format', () => {
    const result = analyzeSender('John Doe <john@example.com>');
    assert.strictEqual(result.email, 'john@example.com');
    assert.strictEqual(result.display_name, 'John Doe');
    assert.strictEqual(result.domain, 'example.com');
    assert.strictEqual(result.root_domain, 'example.com');
  });

  test('parses email with quoted display name', () => {
    const result = analyzeSender('"Support Team" <support@company.com>');
    assert.strictEqual(result.email, 'support@company.com');
    assert.strictEqual(result.display_name, 'Support Team');
  });

  test('parses bare email address', () => {
    const result = analyzeSender('user@domain.com');
    assert.strictEqual(result.email, 'user@domain.com');
    assert.strictEqual(result.domain, 'domain.com');
  });

  test('handles null input', () => {
    const result = analyzeSender(null);
    assert.strictEqual(result.email, null);
  });

  test('extracts root domain from sender with subdomain', () => {
    const result = analyzeSender('Alerts <alerts@mail.bankco.com>');
    assert.strictEqual(result.domain, 'mail.bankco.com');
    assert.strictEqual(result.root_domain, 'bankco.com');
  });
});

// ============================================================================
// FIXTURE-BASED TESTS - Test against actual email fixtures
// ============================================================================

describe('URL extraction from phishing email fixture', () => {
  const phishingEmail = loadFixture('raw/phishing_fake_urgent.eml');

  test('extracts URLs from phishing email', () => {
    const result = extractUrls(phishingEmail);
    assert.ok(result.count >= 2, 'Should find at least 2 URLs in phishing email');
  });

  test('detects mismatched URLs in phishing email', () => {
    const result = extractUrls(phishingEmail);
    assert.strictEqual(result.has_mismatched_urls, true, 'Should detect mismatched URLs');
    // The phishing email has apple.com display text linking to scamsite.ru
    assert.ok(result.unique_domains.includes('scamsite.ru'), 'Should include scamsite.ru in domains');
  });

  test('analyzes phishing sender correctly', () => {
    // Extract From header from the email
    const fromMatch = phishingEmail.match(/^From:\s*(.+)$/m);
    assert.ok(fromMatch, 'Should find From header');
    
    const result = analyzeSender(fromMatch[1]);
    assert.strictEqual(result.root_domain, 'scamsite.ru', 'Sender root domain should be scamsite.ru');
    assert.ok(
      result.email.includes('scamsite.ru'),
      'Sender email should be from scamsite.ru'
    );
  });
});

describe('URL extraction from legitimate bank email fixture', () => {
  const legitEmail = loadFixture('raw/legit_urgent_bank.eml');

  test('extracts URLs from legitimate email', () => {
    const result = extractUrls(legitEmail);
    assert.ok(result.count >= 1, 'Should find at least 1 URL in legitimate email');
  });

  test('does NOT flag mismatched URLs in legitimate email', () => {
    const result = extractUrls(legitEmail);
    assert.strictEqual(result.has_mismatched_urls, false, 'Should NOT detect mismatched URLs in legit email');
  });

  test('all URLs point to wellsfargo.com', () => {
    const result = extractUrls(legitEmail);
    // All domains should be wellsfargo.com
    assert.ok(
      result.unique_domains.every(d => d === 'wellsfargo.com'),
      'All domains should be wellsfargo.com'
    );
  });

  test('analyzes legitimate sender correctly', () => {
    // Extract From header from the email
    const fromMatch = legitEmail.match(/^From:\s*(.+)$/m);
    assert.ok(fromMatch, 'Should find From header');
    
    const result = analyzeSender(fromMatch[1]);
    assert.strictEqual(result.root_domain, 'wellsfargo.com', 'Sender root domain should be wellsfargo.com');
  });
});

describe('URL extraction from IP-based phishing email fixture', () => {
  const ipPhishingEmail = loadFixture('raw/phishing_ip_based.eml');

  test('extracts URLs from IP-based phishing email', () => {
    const result = extractUrls(ipPhishingEmail);
    assert.ok(result.count >= 3, 'Should find at least 3 URLs in IP phishing email');
  });

  test('detects IP-based URLs', () => {
    const result = extractUrls(ipPhishingEmail);
    assert.strictEqual(result.has_ip_based_urls, true, 'Should detect IP-based URLs');
  });

  test('includes IP addresses in unique_domains', () => {
    const result = extractUrls(ipPhishingEmail);
    // Should include the IP addresses in the domains list for LLM to see
    const hasIpDomain = result.unique_domains.some(d => 
      /^\d+\.\d+\.\d+\.\d+$/.test(d) || d.startsWith('[')
    );
    assert.ok(hasIpDomain, 'Should include IP addresses in unique_domains');
  });

  test('sender domain does not match claimed brand (for LLM to evaluate)', () => {
    // Extract From header from the email
    const fromMatch = ipPhishingEmail.match(/^From:\s*(.+)$/m);
    assert.ok(fromMatch, 'Should find From header');
    
    const result = analyzeSender(fromMatch[1]);
    // Email claims to be "Cloud Storage" but sender is semaslim.net
    assert.strictEqual(result.root_domain, 'semaslim.net', 'Sender should be semaslim.net, not apple.com or icloud.com');
    // The LLM should recognize this mismatch between claimed brand and sender
  });
});

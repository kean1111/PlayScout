import re
import os

html_path = r"C:\Users\user\.gemini\antigravity\brain\c39cbec3-415b-4029-b5b5-901f27843b91\.user_uploaded\media_1787193027750.html"
out_dir = r"C:\Users\user\.gemini\antigravity\scratch\playscout"

with open(html_path, 'r', encoding='utf-8') as f:
    content = f.read()

css_match = re.search(r'<style>(.*?)</style>', content, re.DOTALL)
css = css_match.group(1).strip() if css_match else ""

js_match = re.search(r'<script>(.*?)</script>', content, re.DOTALL)
js = js_match.group(1).strip() if js_match else ""

new_storage_code = """  var STORAGE_AVAILABLE = true;
  function warnStorageUnavailableOnce(){}
  function safeStorageGet(key, shared){
    return Promise.resolve({ value: localStorage.getItem(key) });
  }
  function safeStorageSet(key, value, shared){
    try {
      localStorage.setItem(key, value);
      return Promise.resolve();
    } catch(e) {
      return Promise.reject(e);
    }
  }"""
js = re.sub(
    r"var STORAGE_AVAILABLE =.*?return window\.storage\.set\(key, value, shared\);\s*\}",
    new_storage_code,
    js,
    flags=re.DOTALL
)

html_body = re.sub(r'<style>.*?</style>', '', content, flags=re.DOTALL)
html_body = re.sub(r'<script>.*?</script>', '', html_body, flags=re.DOTALL)

links = "\n    ".join(re.findall(r'<link.*?>', html_body))
html_body = re.sub(r'<link.*?>', '', html_body)

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' https: http: data: blob:; connect-src 'self' https: http: blob:; font-src 'self' https: data:;">
    <title>PlayScout Automation</title>
    {links}
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    {html_body.strip()}
    <script src="app.js"></script>
</body>
</html>"""

os.makedirs(out_dir, exist_ok=True)

with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
    f.write(html)
with open(os.path.join(out_dir, "styles.css"), "w", encoding="utf-8") as f:
    f.write(css)
with open(os.path.join(out_dir, "app.js"), "w", encoding="utf-8") as f:
    f.write(js)

print("Successfully extracted HTML, CSS, and JS.")

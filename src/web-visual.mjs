import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Sandbox} from './sandbox.mjs';
import {checked} from './process.mjs';

export const WEB_VISUAL_TASK_ID='world-clock';
const MAX_HTML=2*1024*1024;
const HTML_CHECK=String.raw`
import sys,re
from html.parser import HTMLParser
p='/workspace/world-clock.html'
data=open(p,'rb').read(2097153)
if not data or len(data)>2097152: raise ValueError('HTML must be 1 byte to 2 MiB')
text=data.decode('utf-8','strict')
if re.search(r'<!\s*(?:DOCTYPE\s+[^>]*\bSYSTEM\b|ENTITY)',text,re.I): raise ValueError('External declarations are forbidden')
class Check(HTMLParser):
 def __init__(self):
  super().__init__(convert_charrefs=True);self.count=0;self.scripts=[];self.in_script=False;self.styles=[];self.inline_styles=[];self.in_style=False;self.title=[];self.in_title=False
 def handle_starttag(self,tag,attrs):
  self.count+=1
  if self.count>5000: raise ValueError('HTML is too complex')
  tag=tag.lower();a={k.lower():v or '' for k,v in attrs}
  if tag in {'base','iframe','frame','frameset','object','embed','applet','form'}: raise ValueError('Embedded browsing, objects and forms are forbidden')
  if tag=='meta' and a.get('http-equiv','').lower()=='refresh': raise ValueError('Navigation is forbidden')
  if tag=='script':
   if 'src' in a: raise ValueError('External scripts are forbidden')
   self.in_script=True
  if tag=='style': self.in_style=True
  if tag=='title': self.in_title=True
  if 'style' in a:self.inline_styles.append(a['style'])
  for k,v in a.items():
   if k.startswith('on'): raise ValueError('Inline event handlers are forbidden')
   if k in {'href','src','action','formaction','poster'}:
    value=v.strip()
    if value and not value.startswith('#') and not (k in {'src','poster'} and re.match(r'^data:(?:image|font)/',value,re.I)):
     raise ValueError('External references are forbidden')
 def handle_startendtag(self,tag,attrs): self.handle_starttag(tag,attrs)
 def handle_endtag(self,tag):
  if tag.lower()=='script': self.in_script=False
  if tag.lower()=='style': self.in_style=False
  if tag.lower()=='title': self.in_title=False
 def handle_data(self,data):
  if self.in_script:self.scripts.append(data)
  if self.in_style:self.styles.append(data)
  if self.in_title:self.title.append(data)
c=Check();c.feed(text);c.close()
style='\n'.join(c.styles+c.inline_styles)
if re.search(r'@import\b',style,re.I): raise ValueError('CSS imports are forbidden')
for raw in re.findall(r'url\s*\(([^)]*)\)',style,re.I):
 value=raw.strip().strip('\\"\\\'').strip()
 if value and not value.startswith('#') and not re.match(r'^data:(?:image|font)/',value,re.I): raise ValueError('External CSS references are forbidden')
script='\n'.join(c.scripts)
if re.search(r'''["'][ \t]*(?:(?:https?|wss?|ftp):|//[^/\s])''',script,re.I): raise ValueError('External script URLs are forbidden')
if not script.strip(): raise ValueError('An inline script is required')
if not re.search(r'\b(?:new\s+)?Date\s*\(',script): raise ValueError('Clock must read the current time')
if not re.search(r'\b(?:setInterval|setTimeout|requestAnimationFrame)\s*\(',script): raise ValueError('Clock must update continuously')
if re.search(r'\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|importScripts)\b',script): raise ValueError('Network-capable APIs are forbidden')
if not ''.join(c.title).strip(): raise ValueError('A document title is required')
# The browser check validates hooks in the rendered DOM so inline scripts may create them.
print('Valid self-contained world clock')
`;

const SELENIUM_CHECK=String.raw`
import datetime,json,math,os,re,sys,time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
open('/tmp/clock.html','wb').write(sys.stdin.buffer.read())
os.environ['HOME']='/tmp'
options=Options();options.binary_location='/usr/bin/chromium'
for arg in ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-crash-reporter','--disable-breakpad','--user-data-dir=/tmp/chrome']:
 options.add_argument(arg)
driver=webdriver.Chrome(service=Service('/usr/bin/chromedriver'),options=options)
def angle(kind):
 found=driver.find_elements(By.CSS_SELECTOR,'[data-clock-hand="'+kind+'"]')
 if not found or not found[0].is_displayed(): return None
 value=found[0].value_of_css_property('transform')
 numbers=[float(x) for x in re.findall(r'-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?',value,re.I)]
 if value.startswith('matrix3d(') and len(numbers)==16: a,b=numbers[0],numbers[1]
 elif value.startswith('matrix(') and len(numbers)==6: a,b=numbers[0],numbers[1]
 else: return None
 return (math.degrees(math.atan2(b,a))+360)%360
def delta(a,b): return abs((a-b+180)%360-180)
def hands(): return {kind:angle(kind) for kind in ['hour','minute','second']}
try:
 width,height=int(sys.argv[1]),int(sys.argv[2])
 driver.execute_cdp_cmd('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
 driver.set_page_load_timeout(5);driver.get('file:///tmp/clock.html')
 first=hands();time.sleep(1.2);last=hands();now=datetime.datetime.now()
 expected={'second':now.second*6,'minute':(now.minute+now.second/60)*6,'hour':((now.hour%12)+now.minute/60)*30}
 errors=[]
 for kind in ['hour','minute','second']:
  if last[kind] is None: errors.append(kind+' hand has no visible CSS transform')
 if first['second']==last['second']: errors.append('second hand did not move')
 for kind,tolerance in [('second',12),('minute',4),('hour',3)]:
  if last[kind] is not None and delta(last[kind],expected[kind])>tolerance: errors.append(kind+' hand is not current')
 faces=driver.find_elements(By.CSS_SELECTOR,'[data-clock-face]')
 if not faces or not faces[0].is_displayed(): errors.append('primary clock is not visible')
 else:
  face=faces[0].rect
  if face['width']<140 or face['height']<140 or face['x']<0 or face['y']<0 or face['x']+face['width']>width+2 or face['y']+face['height']>height+2: errors.append('primary clock does not fit viewport')
 locations=[e for e in driver.find_elements(By.CSS_SELECTOR,'[data-world-location]') if e.is_displayed() and e.text.strip()]
 if len(locations)<4: errors.append('world locations are not visibly named')
 frame=driver.execute_cdp_cmd('Page.getFrameTree',{})['frameTree']['frame']['id']
 context=driver.execute_cdp_cmd('Page.createIsolatedWorld',{'frameId':frame,'worldName':'hemsoft-check','grantUniveralAccess':False})['executionContextId']
 content_width=driver.execute_cdp_cmd('Runtime.evaluate',{'expression':'document.documentElement.scrollWidth','contextId':context,'returnByValue':True})['result']['value']
 if content_width>width+2: errors.append('page scrolls horizontally ('+str(round(content_width))+'px for '+str(width)+'px viewport)')
 print(json.dumps({'ok':not errors,'errors':errors}))
finally:
 driver.quit()
`;

async function browserCheck(renderer,source,width,height){
  const output=await checked('docker',['run','--rm','-i','--pull=never','--network=none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m',renderer,'timeout','12','/usr/bin/python3','-c',SELENIUM_CHECK,String(width),String(height)],{input:source,timeoutMs:20000,maxBytes:8192});
  let result;try{result=JSON.parse(output.trim());}catch{throw new Error('Clock did not complete the offline browser check.');}
  if(!result.ok)throw new Error(`${width}x${height}: ${result.errors.join('; ')}`);
}

export async function validateWorldClock(image,renderer,source) {
  if(!Buffer.isBuffer(source)||source.length<1||source.length>MAX_HTML)throw new Error('HTML must be 1 byte to 2 MiB.');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(source);
  const box=await new Sandbox(image).start();
  try{
    await box.file('write',{path:'world-clock.html',content:text});
    await checked('docker',['exec',box.name,'timeout','5','python','-I','-c',HTML_CHECK],{timeoutMs:12000,maxBytes:4096});
  }finally{await box.dispose();}
  await browserCheck(renderer,source,1200,800);
  await browserCheck(renderer,source,390,844);
}

export async function saveWorldClock(source,directory) {
  if(!Buffer.isBuffer(source)||source.length<1||source.length>MAX_HTML)throw new Error('HTML must be 1 byte to 2 MiB.');
  const path=join(directory,'world-clock.html');
  await writeFile(path,source,{flag:'wx',mode:0o600});
  return {
    presentation:{kind:'webpage',label:'World clock',file:path},
    sha256:createHash('sha256').update(source).digest('hex'),
  };
}

import {mkdir,open,lstat,link,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Sandbox} from './sandbox.mjs';
import {checked} from './process.mjs';

export const VISUAL_TASK_ID='kangaroo-bike';
const MAX_SVG=1024*1024;
const SVG_CHECK=String.raw`
import sys,re,xml.etree.ElementTree as ET
sys.tracebacklimit=0
p='/workspace/bike.svg'
data=open(p,'rb').read(1048577)
if not data or len(data)>1048576: raise ValueError('SVG must be 1 byte to 1 MiB')
if re.search(rb'<!\s*(?:DOCTYPE|ENTITY)|<\?(?!xml\s)',data,re.I): raise ValueError('DTD, entities and processing instructions are forbidden')
root=ET.fromstring(data)
ns='{http://www.w3.org/2000/svg}'
xlink_href='{http://www.w3.org/1999/xlink}href'
def local_href(el):
 return el.attrib.get('href',el.attrib.get(xlink_href,''))
allowed={'svg','g','path','circle','ellipse','rect','line','polyline','polygon','text','tspan','defs','linearGradient','radialGradient','stop','clipPath','mask','pattern','style','title','desc','filter','feGaussianBlur','feDropShadow','use'}
if root.tag!=ns+'svg': raise ValueError('Root must be a namespaced SVG')
def passive_value(v,css=False):
 if '\\' in v or re.search(r'(?:https?|data|javascript|file):|expression\s*\(',v,re.I) or (css and '@' in v):
  raise ValueError('Active content or external reference')
 # Self-contained gradients and masks may use a local fragment reference.
 remaining=re.sub(r'url\s*\(\s*([\"\']?)#[A-Za-z_][A-Za-z0-9_.-]*\1\s*\)', '', v,flags=re.I)
 if re.search(r'url\s*\(',remaining,re.I): raise ValueError('External or malformed SVG URL')
ids={}
for node in root.iter():
 value=node.attrib.get('id')
 if value is not None:
  if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]*',value) or value in ids: raise ValueError('Invalid or duplicate SVG id')
  ids[value]=node
count=0
uses=[]
stack=[(root,0)]
while stack:
 el,depth=stack.pop();count+=1
 if count>5000 or depth>80: raise ValueError('SVG is too complex')
 if not el.tag.startswith(ns) or el.tag[len(ns):] not in allowed: raise ValueError('Unsupported SVG element: '+el.tag.rsplit('}',1)[-1])
 for k,v in el.attrib.items():
  name=k.split('}')[-1].lower()
  if k.startswith('{') and k!=xlink_href and not k.startswith('{http://www.w3.org/XML/1998/namespace}'):
   raise ValueError('Foreign attribute namespace')
  if name=='href':
   if el.tag!=ns+'use' or k not in ('href',xlink_href) or not re.fullmatch(r'#[A-Za-z_][A-Za-z0-9_.-]*',v): raise ValueError('Active content or external reference')
   uses.append((el,v[1:]));continue
  if name.startswith('on') or name in ('src','style'):
   raise ValueError('Active content or external reference')
  passive_value(v)
 if el.tag==ns+'style': passive_value(''.join(el.itertext()),css=True)
 stack.extend((child,depth+1) for child in el)
for _,target in uses:
 if target not in ids: raise ValueError('Missing local SVG reference')
def expanded(el,path,depth):
 if depth>80: raise ValueError('SVG is too complex')
 marker=id(el)
 if marker in path: raise ValueError('Cyclic local SVG reference')
 path=path|{marker};total=1
 if el.tag==ns+'use':
  if not local_href(el): raise ValueError('Use elements require a local href')
  total+=expanded(ids[local_href(el)[1:]],path,depth+1)
 for child in el: total+=expanded(child,path,depth+1)
 if total>5000: raise ValueError('SVG is too complex')
 return total
expanded(root,set(),0)
print('Valid passive SVG')
`;

export function visualFilename(model) {
 // Use the exact Pi model ID's last segment, never the user-facing label.
 const id=model?.model;
 if(typeof id!=='string'||!/(?=.{1,200}$)^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(id)||id.split('/').some(s=>s==='.'||s==='..'))throw new Error('Model ID cannot be mapped safely to an SVG filename.');
 const name=id.split('/').at(-1);
 if(name.length>100)throw new Error('Model ID is too long for a named SVG.');
 return `${name}-bike.svg`;
}

export async function validateSvg(image,source) {
 if(!Buffer.isBuffer(source)||source.length<1||source.length>MAX_SVG)throw new Error('SVG must be 1 byte to 1 MiB.');
 const box=await new Sandbox(image).start();
 try{
  // Preserve bytes exactly. The validator never runs candidate code or sees a
  // network connection, even when given hostile SVG content.
  await box.file('write',{path:'bike.svg',content:new TextDecoder('utf-8',{fatal:true}).decode(source)});
  await checked('docker',['exec',box.name,'timeout','5','python','-I','-c',SVG_CHECK],{timeoutMs:12000,maxBytes:4096});
 }finally{await box.dispose();}
}

const MAX_PNG=8*1024*1024;
const PNG_HEADER=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');

export async function rasterizeSvg(rendererImage,source) {
 if(!Buffer.isBuffer(source)||source.length<1||source.length>MAX_SVG)throw new Error('SVG exceeds 1 MiB.');
 const box=await new Sandbox(rendererImage).start();
 try{
  await box.file('write',{path:'bike.svg',content:new TextDecoder('utf-8',{fatal:true}).decode(source)});
  await checked('docker',['exec',box.name,'timeout','-k','1','15','rsvg-convert','--format=png','--width=1200','--height=1200','--keep-aspect-ratio','--output=/workspace/bike.png','/workspace/bike.svg'],{timeoutMs:20000,maxBytes:4096});
  const encoded=await checked('docker',['exec',box.name,'timeout','5','python','-I','-c',
   "import os,stat,sys,base64; fd=os.open('/workspace/bike.png',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); s=os.fstat(fd); assert stat.S_ISREG(s.st_mode) and 24<s.st_size<=8388608, 'PNG must be a regular file <=8 MiB'; data=os.read(fd,8388609); os.close(fd); assert len(data)==s.st_size, 'PNG changed while reading'; sys.stdout.write(base64.b64encode(data).decode('ascii'))"],{timeoutMs:12000,maxBytes:MAX_PNG*4/3+4096});
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length%4!==0)throw new Error('Invalid encoded PNG.');
  const png=Buffer.from(encoded,'base64');
  if(png.length>MAX_PNG||png.length<24||!png.subarray(0,PNG_HEADER.length).equals(PNG_HEADER)||png.readUInt32BE(16)>1200||png.readUInt32BE(20)>1200)throw new Error('Renderer did not produce a bounded PNG.');
  return png;
 }finally{await box.dispose();}
}

export async function publishSvg(root,model,source,png,directory) {
 if(!Buffer.isBuffer(png)||png.length>MAX_PNG||!png.subarray(0,PNG_HEADER.length).equals(PNG_HEADER))throw new Error('A rendered PNG is required.');
 const local=join(root,'.local'),results=join(local,'results');
 for(const path of [local,results]){
  try{const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Linked or non-directory artifact store refused.');}
  catch(e){if(e.code!=='ENOENT')throw e;if(path===local)throw new Error('Missing .local artifact store.');await mkdir(path);}
 }
 const filename=visualFilename(model),path=resolve(results,filename),pngPath=resolve(results,filename.replace(/\.svg$/,'.png'));
 if(resolve(path,'..')!==resolve(results)||resolve(pngPath,'..')!==resolve(results))throw new Error('Unexpected artifact path.');
 const owned=join(directory,'bike.svg'),pngOwned=join(directory,'bike.png');
 await writeFile(owned,source,{flag:'wx',mode:0o600});
 await writeFile(pngOwned,png,{flag:'wx',mode:0o600});
 const existing=async target=>{
  try{const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink())throw new Error('Existing image target is linked or not a regular file.');return true;}
  catch(e){if(e.code==='ENOENT')return false;throw e;}
 };
 let collision=(await existing(path))||(await existing(pngPath));
 const svgTemp=join(results,`.${randomUUID()}.svg.tmp`),pngTemp=join(results,`.${randomUUID()}.png.tmp`);
 let svgPublished=false,pngPublished=false;
 if(!collision){
  try{
   for(const [temp,data] of [[svgTemp,source],[pngTemp,png]]){
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(data);}finally{await handle.close();}
   }
   try{await link(svgTemp,path);svgPublished=true;}catch(e){if(e.code!=='EEXIST')throw e;collision=true;}
   if(svgPublished){try{await link(pngTemp,pngPath);pngPublished=true;}catch(e){if(e.code!=='EEXIST')throw e;collision=true;}}
  }finally{
   if(svgPublished&&!pngPublished){
    const [target,temp]=await Promise.all([lstat(path),lstat(svgTemp)]);
    if(target.dev===temp.dev&&target.ino===temp.ino)await rm(path);
   }
   await rm(svgTemp,{force:true});await rm(pngTemp,{force:true});
  }
 }
 if(collision){await existing(path);await existing(pngPath);}
 const published=svgPublished&&pngPublished;
 return {file:published?path:owned,publicFile:published?path:null,ownedFile:owned,
  pngFile:published?pngPath:pngOwned,pngPublicFile:published?pngPath:null,pngOwnedFile:pngOwned,
  published,collision:!published,sha256:createHash('sha256').update(source).digest('hex'),pngSha256:createHash('sha256').update(png).digest('hex')};
}

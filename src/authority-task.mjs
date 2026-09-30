function lexical(a,b) {
  for(let i=0;i<Math.min(a.length,b.length);i++) {
    if(a[i]!==b[i])return a[i]<b[i]?-1:1;
  }
  return a.length-b.length;
}

function betterPath(candidate,current) {
  return current===undefined || candidate.length<current.length || (candidate.length===current.length && lexical(candidate,current)<0);
}

function activeVersions({versions},known,at) {
  const selected=new Map();
  for(const version of versions) {
    if(version.recorded>known)continue;
    const current=selected.get(version.fact);
    if(!current || version.recorded>current.recorded || (version.recorded===current.recorded && version.id>current.id))selected.set(version.fact,version);
  }
  return [...selected.values()].filter(version=>version.payload!==null && version.valid[0]<=at && (version.valid[1]===null || at<version.valid[1]));
}

function membershipPaths(versions,subject) {
  const adjacent=new Map();
  for(const version of versions) {
    if(version.payload.kind!=='member')continue;
    const {member,group}=version.payload;
    if(!adjacent.has(member))adjacent.set(member,new Set());
    adjacent.get(member).add(group);
  }
  const paths=new Map([[subject,[subject]]]), queue=[subject];
  while(queue.length) {
    const member=queue.shift(), base=paths.get(member);
    for(const group of [...(adjacent.get(member)??[])].sort()) {
      const candidate=[...base,group];
      if(betterPath(candidate,paths.get(group))) {
        paths.set(group,candidate);
        queue.push(group);
      }
    }
  }
  return paths;
}

function resourceDistances(resources,resource) {
  const parents=new Map(resources.map(item=>[item.id,item.parent]));
  const distances=new Map();
  for(let current=resource,distance=0;current!==null;current=parents.get(current),distance++)distances.set(current,distance);
  return distances;
}

function proofCompare(a,b) {
  return a.length-b.length || lexical(a,b);
}

function authorizeRules(rules,resources,memberships) {
  const states=new Map(rules.map(rule=>[rule.id,new Map()]));
  for(const rule of rules)if(rule.payload.issuer==='ROOT')states.get(rule.id).set(rule.payload.delegate,[rule.id]);
  let changed=true;
  while(changed) {
    changed=false;
    for(const child of rules) {
      if(child.payload.issuer==='ROOT')continue;
      const childStates=states.get(child.id);
      const issuerPaths=membershipPaths(memberships,child.payload.issuer);
      const childAncestors=resourceDistances(resources,child.payload.resource);
      for(const parent of rules) {
        if(parent.payload.effect!=='allow' || !issuerPaths.has(parent.payload.subject) || !childAncestors.has(parent.payload.resource))continue;
        if(parent.payload.action!=='*' && parent.payload.action!==child.payload.action)continue;
        for(const [remaining,proof] of states.get(parent.id)) {
          if(remaining<1 || proof.includes(child.id))continue;
          const nextRemaining=Math.min(child.payload.delegate,remaining-1);
          const candidate=[...proof,child.id], current=childStates.get(nextRemaining);
          if(current===undefined || proofCompare(candidate,current)<0) {
            childStates.set(nextRemaining,candidate);
            changed=true;
          }
        }
      }
    }
  }
  return states;
}

function compareCandidate(a,b) {
  for(let i=0;i<4;i++)if(a.rank[i]!==b.rank[i])return a.rank[i]-b.rank[i];
  const proof=proofCompare(a.proof,b.proof);if(proof)return proof;
  const subject=lexical(a.subjectPath,b.subjectPath);if(subject)return subject;
  return a.rule.id<b.rule.id?-1:a.rule.id>b.rule.id?1:0;
}

export function authorityReference(testCase) {
  return testCase.queries.map(query=>{
    const active=activeVersions(testCase,query.known,query.at);
    const memberships=active.filter(version=>version.payload.kind==='member');
    const rules=active.filter(version=>version.payload.kind==='rule');
    const subjectPaths=membershipPaths(memberships,query.subject);
    const resourceDistance=resourceDistances(testCase.resources,query.resource);
    const states=authorizeRules(rules,testCase.resources,memberships);
    const candidates=[];
    for(const rule of rules) {
      const paths=states.get(rule.id);
      if(paths.size===0 || !subjectPaths.has(rule.payload.subject) || !resourceDistance.has(rule.payload.resource))continue;
      if(rule.payload.action!=='*' && rule.payload.action!==query.action)continue;
      const proof=[...paths.values()].sort(proofCompare)[0];
      const subjectPath=subjectPaths.get(rule.payload.subject);
      candidates.push({rule,proof,subjectPath,rank:[resourceDistance.get(rule.payload.resource),subjectPath.length-1,rule.payload.action==='*'?1:0,rule.payload.effect==='deny'?0:1]});
    }
    if(candidates.length===0)return {decision:'deny',rule:null,authority:[],subjectPath:[]};
    candidates.sort(compareCandidate);
    const winner=candidates[0];
    return {decision:winner.rule.payload.effect,rule:winner.rule.id,authority:winner.proof,subjectPath:winner.subjectPath};
  });
}

function resourceTree(count) {
  return Array.from({length:count},(_,i)=>({id:`r${i}`,parent:i===0?null:`r${Math.floor((i-1)/2)}`}));
}

function version(id,fact,recorded,valid,payload) { return {id,fact,recorded,valid,payload}; }
function member(id,fact,recorded,memberName,group,valid=[0,null]) { return version(id,fact,recorded,valid,{kind:'member',member:memberName,group}); }
function rule(id,fact,recorded,issuer,subject,resource,action,effect,delegate=0,valid=[0,null]) { return version(id,fact,recorded,valid,{kind:'rule',issuer,subject,resource,action,effect,delegate}); }
function query(subject,resource,action,known=100,at=50) { return {subject,resource,action,known,at}; }

function handCases() {
  const tree=resourceTree(4);
  return [
    {resources:tree,versions:[],queries:[query('alice','r0','read')]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r0','read','allow')],queries:[query('alice','r3','read')]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r0','read','allow'),rule('v2','f2',1,'ROOT','alice','r0','read','deny')],queries:[query('alice','r2','read')]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r0','read','deny'),rule('v2','f2',1,'ROOT','alice','r1','read','allow')],queries:[query('alice','r3','read')]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r1','*','deny'),rule('v2','f2',1,'ROOT','alice','r1','read','allow')],queries:[query('alice','r3','read'),query('alice','r3','write')]},
    {resources:tree,versions:[member('m1','m1',1,'alice','team'),member('m2','m2',1,'team','org'),rule('v1','f1',1,'ROOT','org','r0','read','allow')],queries:[query('alice','r2','read')]},
    {resources:tree,versions:[member('m1','m1',1,'alice','g1'),member('m2','m2',1,'g1','g2'),member('m3','m3',1,'g2','g1'),rule('v1','f1',1,'ROOT','g2','r0','read','allow')],queries:[query('alice','r2','read')]},
    {resources:tree,versions:[rule('v1','policy',5,'ROOT','alice','r0','read','allow'),rule('v2','policy',20,'ROOT','alice','r0','read','deny')],queries:[query('alice','r0','read',10),query('alice','r0','read',30)]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r0','read','allow',0,[10,20])],queries:[query('alice','r0','read',50,9),query('alice','r0','read',50,10),query('alice','r0','read',50,20)]},
    {resources:tree,versions:[rule('root','f1',1,'ROOT','admin','r0','*','allow',2),rule('child','f2',2,'admin','alice','r1','read','allow',1)],queries:[query('alice','r3','read')]},
    {resources:tree,versions:[rule('root','f1',1,'ROOT','a','r0','*','allow',2),rule('mid','f2',2,'a','b','r0','read','allow',2),rule('leaf','f3',3,'b','c','r1','read','allow',2),rule('too','f4',4,'c','d','r1','read','allow',2)],queries:[query('c','r3','read'),query('d','r3','read')]},
    {resources:tree,versions:[rule('a','f1',1,'b','a','r0','read','allow',4),rule('b','f2',1,'a','b','r0','read','allow',4)],queries:[query('a','r0','read'),query('b','r0','read')]},
    {resources:tree,versions:[rule('root1','f1',1,'ROOT','a','r0','read','allow',3),rule('root2','f1',20,'ROOT','a','r0','read','allow',0),rule('child','f2',2,'a','bob','r0','read','allow',2)],queries:[query('bob','r0','read',10),query('bob','r0','read',30)]},
    {resources:tree,versions:[rule('ra','f1',1,'ROOT','a','r0','read','allow',3),rule('rb','f2',1,'ROOT','b','r0','read','allow',3),rule('ca','f3',2,'a','c','r0','read','allow',2),rule('cb','f4',2,'b','c','r0','read','allow',2),rule('leaf','f5',3,'c','d','r0','read','allow',0)],queries:[query('d','r0','read')]},
    {resources:tree,versions:[rule('v1','f1',1,'ROOT','alice','r0','read','allow'),version('v2','f1',20,[0,null],null)],queries:[query('alice','r0','read',10),query('alice','r0','read',30)]}
  ];
}

function random(seed) { let state=seed>>>0; return n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;}; }

function delegationCase(rand,index) {
  const resources=resourceTree(9), action=['read','write','deploy'][rand(3)];
  const versions=[], chainLength=2+rand(3), issuers=Array.from({length:chainLength},(_,i)=>`agent${index}_${i}`), target=`target${index}`;
  versions.push(member(`dm${index}`,`dm${index}`,1,issuers[0],`admins${index}`));
  versions.push(rule(`dr${index}_0`,`drf${index}_0`,1,'ROOT',`admins${index}`,'r0','*','allow',chainLength+1));
  for(let i=1;i<chainLength;i++)versions.push(rule(`dr${index}_${i}`,`drf${index}_${i}`,2+i,issuers[i-1],issuers[i],'r0',action,'allow',chainLength-i+1));
  versions.push(rule(`dr${index}_${chainLength}`,`drf${index}_${chainLength}`,5+chainLength,issuers[chainLength-1],target,'r3',action,'allow',1));
  versions.push(rule(`broad-deny${index}`,`deny${index}`,1,'ROOT',target,'r0','*','deny',0));
  if(index%3===0)versions.push(version(`retract${index}`,`drf${index}_1`,70,[0,null],null));
  const queries=[query(target,'r7',action,50,25),query(target,'r7',action,90,25)];
  return {resources,versions,queries};
}

function generatedCase(rand,index,large=false) {
  const resourceCount=large?32:7+rand(6), resources=resourceTree(resourceCount);
  const principalCount=large?28:8, groupCount=large?18:6;
  const principals=Array.from({length:principalCount},(_,i)=>`p${i}`);
  const groups=Array.from({length:groupCount},(_,i)=>`g${i}`);
  const actions=['read','write','deploy','approve'];
  const versions=[];
  let serial=0;
  const add=(fact,recorded,valid,payload)=>versions.push(version(`v${index}_${serial++}`,fact,recorded,valid,payload));
  const membershipCount=large?110:10+rand(8);
  for(let i=0;i<membershipCount;i++) {
    const fact=`m${i}`, memberName=rand(3)===0?groups[rand(groups.length)]:principals[rand(principals.length)], group=groups[rand(groups.length)];
    const payload={kind:'member',member:memberName,group};
    add(fact,1+rand(35),[rand(15),rand(4)===0?30+rand(50):null],payload);
    if(rand(5)===0)add(fact,45+rand(30),[rand(20),null],rand(4)===0?null:{...payload,group:groups[rand(groups.length)]});
  }
  const ruleCount=large?190:18+rand(10);
  for(let i=0;i<ruleCount;i++) {
    const fact=`f${i}`, root=i<Math.max(2,Math.floor(ruleCount/5)) || rand(4)===0;
    const payload={kind:'rule',issuer:root?'ROOT':principals[rand(principals.length)],subject:rand(3)===0?groups[rand(groups.length)]:principals[rand(principals.length)],resource:`r${rand(resourceCount)}`,action:rand(5)===0?'*':actions[rand(actions.length)],effect:rand(4)===0?'deny':'allow',delegate:rand(4)};
    add(fact,1+rand(45),[rand(15),rand(5)===0?35+rand(55):null],payload);
    if(rand(6)===0) {
      const revised=rand(5)===0?null:{...payload,effect:rand(3)===0?(payload.effect==='allow'?'deny':'allow'):payload.effect,delegate:rand(4)};
      add(fact,55+rand(35),[rand(20),null],revised);
    }
  }
  const queryCount=large?55:4+rand(4), queries=[];
  for(let i=0;i<queryCount;i++)queries.push(query(principals[rand(principals.length)],`r${rand(resourceCount)}`,actions[rand(actions.length)],20+rand(81),rand(80)));
  return {resources,versions,queries};
}

export function authorityCases() {
  const rand=random(0x5e11a77), cases=handCases();
  for(let i=0;i<45;i++)cases.push(i<10?delegationCase(rand,i):generatedCase(rand,i,i>=42));
  return cases;
}

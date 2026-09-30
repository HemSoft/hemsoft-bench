import json,sys

TERMINAL={'succeeded','failed','cancelled','blocked'}

class Engine:
    def __init__(self,workers,until=0):
        self.workers={w['id']:{**w,'labels':set(w.get('labels',[])),'usedCpu':0,'usedMemory':0,'up':True} for w in workers}
        self.until=until;self.now=0;self.jobs={};self.keys={};self.effects=set();self.timeline=[]
    def emit(self,at,kind,j,**extra): self.timeline.append({'at':at,'event':kind,'job':j['id'],**extra})
    def release(self,j):
        if j['worker']:
            w=self.workers.get(j['worker'])
            if w:w['usedCpu']-=j['cpu'];w['usedMemory']-=j['memory']
        j['worker']=j['token']=j['leaseUntil']=None
    def propagate(self,at):
        changed=True
        while changed:
            changed=False
            for j in self.jobs.values():
                if j['status']!='pending':continue
                bad=next((x for x in j['requires'] if x in self.jobs and self.jobs[x]['status'] in {'failed','cancelled','blocked'}),None)
                if bad is not None:j['status']='blocked';self.emit(at,'blocked',j,dependency=bad);changed=True
    def worker_for(self,j):
        choices=[]
        for w in self.workers.values():
            if not w['up'] or not j['labels'].issubset(w['labels']):continue
            if w['cpu']-w['usedCpu']<j['cpu'] or w['memory']-w['usedMemory']<j['memory']:continue
            rc=w['cpu']-w['usedCpu']-j['cpu'];rm=w['memory']-w['usedMemory']-j['memory']
            choices.append(((rc+rm,rc,rm,w['id']),w))
        return min(choices,key=lambda x:x[0])[1] if choices else None
    def can_run(self,j,at):
        return j['status']=='pending' and j['readyAt']<=at and all(self.jobs.get(x,{}).get('status')=='succeeded' for x in j['requires']) and (not j['mutex'] or not any(x['status']=='running' and x['mutex']==j['mutex'] for x in self.jobs.values()))
    def dispatch(self,at):
        while True:
            ready=[j for j in self.jobs.values() if self.can_run(j,at)]
            ready.sort(key=lambda j:(-(j['priority']+(at-j['submitted'])//j['aging']),j['submitted'],j['id']))
            chosen=None
            for j in ready:
                w=self.worker_for(j)
                if w:chosen=(j,w);break
            if not chosen:return
            j,w=chosen;j['status']='running';j['attempts']+=1;j['worker']=w['id'];j['token']=f"{j['id']}:{j['attempts']}";j['leaseUntil']=at+j['lease'];w['usedCpu']+=j['cpu'];w['usedMemory']+=j['memory']
            self.emit(at,'started',j,worker=w['id'],attempt=j['attempts'],token=j['token'],leaseUntil=j['leaseUntil'])
    def retry(self,j,at,reason):
        attempt=j['attempts'];self.release(j)
        if attempt>=j['maxAttempts']:j['status']='failed';self.emit(at,'failed',j,attempt=attempt,reason=reason)
        else:
            j['status']='pending';j['readyAt']=at+j['backoff']*(2**(attempt-1));self.emit(at,'retry',j,attempt=attempt,reason=reason,readyAt=j['readyAt'])
    def next_internal(self,target):
        values=[]
        for j in self.jobs.values():
            if j['status']=='running':values.append(j['leaseUntil'])
            if j['status']=='pending' and j['readyAt']>self.now:values.append(j['readyAt'])
        value=min(values,default=10**30)
        return value if value<=target else None
    def advance(self,target):
        while (t:=self.next_internal(target)) is not None:
            self.now=t
            for j in sorted((x for x in self.jobs.values() if x['status']=='running' and x['leaseUntil']<=t),key=lambda x:x['id']):self.retry(j,t,'lease')
            self.propagate(t);self.dispatch(t)
        self.now=target
    def submit(self,spec,at):
        if spec['id'] in self.jobs or spec.get('key') and spec['key'] in self.keys:return
        r=spec.get('resources',{});j={'id':spec['id'],'key':spec.get('key'),'submitted':at,'priority':spec.get('priority',0),'cpu':r.get('cpu',1),'memory':r.get('memory',1),'labels':set(spec.get('labels',[])),'requires':list(spec.get('requires',[])),'mutex':spec.get('mutex'),'maxAttempts':spec.get('maxAttempts',1),'backoff':spec.get('backoff',1),'lease':spec.get('lease',10),'aging':spec.get('aging',10),'effect':spec.get('effect'),'status':'pending','attempts':0,'readyAt':at,'worker':None,'token':None,'leaseUntil':None}
        self.jobs[j['id']]=j
        if j['key']:self.keys[j['key']]=j['id']
    def apply(self,op):
        at=op['at'];kind=op['type']
        if kind=='submit':self.submit(op['job'],at);return
        if kind in {'workerDown','workerUp'}:
            if op['worker'] in self.workers:self.workers[op['worker']]['up']=kind=='workerUp'
            return
        j=self.jobs.get(op.get('job'))
        if not j:return
        if kind=='cancel' and j['status'] not in TERMINAL:
            if j['status']=='running':self.release(j)
            j['status']='cancelled';self.emit(at,'cancelled',j);return
        if kind=='heartbeat' and j['status']=='running' and op.get('token')==j['token']:
            j['leaseUntil']=at+j['lease'];self.emit(at,'heartbeat',j,token=j['token'],leaseUntil=j['leaseUntil']);return
        if kind in {'finish','fail'} and j['status']=='running' and op.get('token')==j['token']:
            attempt=j['attempts']
            if kind=='fail':self.retry(j,at,'failure')
            else:
                self.release(j);j['status']='succeeded'
                if j['effect']:self.effects.add(j['effect'])
                self.emit(at,'succeeded',j,attempt=attempt)
    def snapshot(self):
        workers=[{**w,'labels':sorted(w['labels'])} for w in self.workers.values()]
        jobs=[{**j,'labels':sorted(j['labels'])} for j in self.jobs.values()]
        return {'workers':workers,'until':self.until,'now':self.now,'jobs':jobs,'keys':self.keys,'effects':sorted(self.effects),'timeline':self.timeline}
    @classmethod
    def restore(cls,state):
        e=cls([],state['until']);e.workers={w['id']:{**w,'labels':set(w['labels'])} for w in state['workers']};e.now=state['now'];e.jobs={j['id']:{**j,'labels':set(j['labels'])} for j in state['jobs']};e.keys=dict(state['keys']);e.effects=set(state['effects']);e.timeline=list(state['timeline']);return e
    def finish(self):
        self.advance(self.until)
        for j in self.jobs.values():
            possible=any(j['labels'].issubset(w['labels']) and w['cpu']>=j['cpu'] and w['memory']>=j['memory'] for w in self.workers.values())
            missing=next((x for x in j['requires'] if x not in self.jobs),None)
            if j['status']=='pending' and (not possible or missing is not None):j['status']='blocked';self.emit(self.now,'blocked',j,dependency=missing)
        visiting=set();done=set();cycles=set()
        def visit(job_id):
            if job_id in visiting:cycles.add(job_id);return True
            if job_id in done:return False
            j=self.jobs.get(job_id)
            if not j or j['status']!='pending':return False
            visiting.add(job_id);cyclic=False
            for dep in j['requires']:
                if visit(dep):cycles.add(job_id);cyclic=True
            visiting.remove(job_id);done.add(job_id);return cyclic
        for job_id in list(self.jobs):visit(job_id)
        for job_id in sorted(cycles):
            j=self.jobs[job_id]
            if j['status']=='pending':j['status']='blocked';self.emit(self.now,'blocked',j,dependency='cycle')
        self.propagate(self.now);self.dispatch(self.now)
        states=[{'id':j['id'],'status':j['status'],'attempts':j['attempts']} for j in self.jobs.values()]
        return {'timeline':self.timeline,'jobs':sorted(states,key=lambda x:x['id']),'effects':sorted(self.effects)}

def solve(case):
    e=Engine(case.get('workers',[]),case.get('until',0));ops=case.get('operations',[]);checkpoint=case.get('checkpoint')
    i=0
    while i<len(ops):
        at=ops[i]['at'];e.advance(at)
        while i<len(ops) and ops[i]['at']==at:
            e.apply(ops[i]);i+=1
            if checkpoint==i:e=Engine.restore(json.loads(json.dumps(e.snapshot())))
        e.propagate(at);e.dispatch(at)
    return e.finish()

def main():
    payload=json.load(sys.stdin);print(json.dumps([solve(case) for case in payload['cases']],separators=(',',':')))
if __name__=='__main__':main()

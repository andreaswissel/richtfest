import {expect,test} from 'bun:test';
import {compareSiteReferences,siteReferenceSchema} from './site-references';
test('reference comparisons retain missing metrics and review scope',()=>{
 const ref=(id:string,value:number,reviewed:boolean)=>siteReferenceSchema.parse({id,label:id,source:'official record',note:'selected comparison',metrics:{footprint:{value,source:'record',sourceDate:'2026-10-18',kind:'calculated',reviewed}}});
 const result=compareSiteReferences([ref('a',100,true),ref('b',300,false)]);
 expect(result.footprint).toEqual({count:2,mean:200,max:300,reviewed:false});
 expect(result.gfz).toBeNull();expect(compareSiteReferences([]).footprint).toBeNull();
});

import { expect, test, vi } from 'vitest';
import { parseFeedbackReply } from '../src/services/feedback-replies';
import { handleEmail } from '../src/services/email';
import { asSystem, connect } from '../src/db';

vi.mock('../src/db',()=>({asSystem:vi.fn(),connect:vi.fn()}));
vi.mock('../src/services/live',()=>({notifyLive:vi.fn()}));
const id='11111111-1111-4111-8111-111111111111';
test('reply parser reads explicit ratings, leaves ambiguous prose unrated, and ignores original quoted content',()=>{
  expect(parseFeedbackReply('Re: FB-'+id,'Rating: 4 Helpful\nThank you\n> Rating: 1 original\n> https://example.test/feedback#'+'a'.repeat(64))).toMatchObject({reference:id,rating:4,comment:'Helpful\nThank you',token:'a'.repeat(64)});
  for(const text of ['4.5','10','Very good','Rating: 6','Thank you\n> Rating: 5']) expect(parseFeedbackReply('',text).rating).toBeNull();
  expect(parseFeedbackReply('','FB-'+id+' 5/5\nHelpful service')).toMatchObject({reference:id,rating:5,comment:'Helpful service'});
});
test('incoming feedback email reaches reply ingestion and does not open a new enquiry',async()=>{
  const queries:{text:string;values:unknown[]}[]=[];
  const tx:any=async(strings:TemplateStringsArray,...values:unknown[])=>{
    const text=strings.join('?'); queries.push({text,values});
    if(text.includes('from workspaces'))return[{id}];
    if(text.includes('receive_feedback_reply'))return[{r:{handled:true,status:'submitted'}}];
    throw new Error('Unexpected query');
  };
  const sql:any={end:vi.fn().mockResolvedValue(undefined)};
  vi.mocked(connect).mockReturnValue(sql);
  vi.mocked(asSystem).mockImplementation(async(_sql,fn)=>({result:await fn(tx),changed:['feedback_responses']}) as any);
  const raw=`From: replies@example.test\r\nTo: feedback@example.test\r\nSubject: Re: FB-${id}\r\nMessage-ID: <feedback-email-test>\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nRating: 5\nHelpful service\n> Original request https://example.test/feedback#${'a'.repeat(64)}`;
  await handleEmail({raw:new Blob([raw]).stream(),from:'replies@example.test',to:'feedback@example.test'} as any,{DEFAULT_WORKSPACE_CODE:'HHC'} as any,{waitUntil:vi.fn()} as any);
  expect(queries).toHaveLength(2);
  expect(queries[1].values[5]).toBe(5);
  expect(queries[1].values[6]).toBe('Helpful service');
  expect(queries[1].values).not.toContain('a'.repeat(64));
});
test('incoming HTML-only feedback email extracts rating and capability token from href',async()=>{
  const queries:{text:string;values:unknown[]}[]=[];
  const tx:any=async(strings:TemplateStringsArray,...values:unknown[])=>{
    const text=strings.join('?'); queries.push({text,values});
    if(text.includes('from workspaces'))return[{id}];
    if(text.includes('receive_feedback_reply'))return[{r:{handled:true,status:'submitted'}}];
    throw new Error('Unexpected query');
  };
  const sql:any={end:vi.fn().mockResolvedValue(undefined)};
  vi.mocked(connect).mockReturnValue(sql);
  vi.mocked(asSystem).mockImplementation(async(_sql,fn)=>({result:await fn(tx),changed:['feedback_responses']}) as any);
  const raw=`From: replies@example.test\r\nTo: feedback@example.test\r\nSubject: Re: Share Feedback [FB-${id}]\r\nMessage-ID: <feedback-html-test>\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<p>Rating: 4</p><p>Great nurse!</p><blockquote><a href="https://example.test/feedback#${'b'.repeat(64)}">Original link</a></blockquote>`;
  await handleEmail({raw:new Blob([raw]).stream(),from:'replies@example.test',to:'feedback@example.test'} as any,{DEFAULT_WORKSPACE_CODE:'HHC'} as any,{waitUntil:vi.fn()} as any);
  expect(queries).toHaveLength(2);
  expect(queries[1].values[5]).toBe(4);
  expect(queries[1].values[6]).toBe('Great nurse!');
});

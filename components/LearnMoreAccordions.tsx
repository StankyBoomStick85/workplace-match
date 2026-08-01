"use client";

import { useState } from "react";

type AccordionKey = "people" | "employers";

export function LearnMoreAccordions() {
  const [openSections, setOpenSections] = useState<Record<AccordionKey, boolean>>({
    people: false,
    employers: false
  });

  function toggleSection(key: AccordionKey) {
    setOpenSections((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <button
          type="button"
          onClick={() => toggleSection("people")}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="min-w-0 text-lg font-bold text-zinc-950">For people looking for work</span>
          <span className="shrink-0 text-sm font-bold text-zinc-500">{openSections.people ? "▾" : "▸"}</span>
        </button>
        {openSections.people ? (
          <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
            <p className="text-sm leading-7 text-zinc-700">
              Every job board asks you to summarize yourself into a resume, then runs that resume through a keyword filter before a human ever sees it. If your words do not match their words, you disappear. What you can actually do never enters into it.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Workplace Match starts from the opposite direction. You upload what you have already done - evaluations, certifications, transcripts, records of real work - and the platform reads those documents and translates them into plain-language capability. Not job titles. Not jargon. What you can actually do, written so anyone can understand it.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              That translation is worth something on its own. The capability statements it produces are written to be used - put them on your resume, use them in an interview, hand them to someone who asked what you have done. Whether or not you ever get a job through this platform, you walk away understanding how to describe your own experience in language a civilian employer recognizes.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Then it puts real jobs on a map. Federal listings, private sector, gig work, all scored against your capability, with pay and drive time visible before you click anything.
            </p>
            <p className="text-sm font-semibold text-zinc-900">What this means in practice:</p>
            <p className="text-sm leading-7 text-zinc-700">
              You see the whole picture, not a curated list. Match percentage is a signal, not a gate. Nothing is hidden from you because an algorithm decided you were not qualified.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Your identity stays yours. Employers see capability and alignment. They do not see your name, your photo, your contact information, or your address. That stays private until you decide to take a conversation forward.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              You find out what you are worth. Switch the map to show pay and you can see, at a glance, what the market actually pays in your area for the work you can do today, and what it pays for the work you could do with one more credential.
            </p>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <button
          type="button"
          onClick={() => toggleSection("employers")}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="min-w-0 text-lg font-bold text-zinc-950">For employers</span>
          <span className="shrink-0 text-sm font-bold text-zinc-500">{openSections.employers ? "▾" : "▸"}</span>
        </button>
        {openSections.employers ? (
          <div className="mt-4 space-y-4 border-t border-gray-200 pt-4">
            <p className="text-sm leading-7 text-zinc-700">
              Every hiring platform sells the same thing: more applicants. Post a role, receive hundreds of resumes, filter aggressively, hope the filter did not discard the person you needed.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Workplace Match is being built to sell something different: clarity about the talent that already exists around you.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              We are early. The candidate side is live and growing. Here is what this becomes as it does.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Market data you cannot get anywhere else. What capability actually exists within your commute radius, at what density, at what alignment to the roles you are trying to fill. Not who applied. What is out there. That is useful before you post anything, and it stays useful whether or not you are hiring this month.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              People who are visible whether or not they are looking. Most capable people are not actively applying. On every other platform they are invisible, because visibility requires them to submit a resume to something. Here they simply have a profile, and their alignment to your role is already calculated whether they are job hunting or not. That population does not exist on any other platform.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Capability instead of keywords. The match is built from what a candidate has demonstrated and verified through actual documents, not from whether their resume happens to use your words. Someone who has never held your job title may be the strongest fit for it, and every keyword system in existence will hide that person from you.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Mutual interest before contact. You express interest, they express interest, and only then does a conversation open. Fewer conversations, better ones, and nobody wasting time on a conversation the other side did not want.
            </p>
            <p className="text-sm leading-7 text-zinc-700">
              Verified before the interview. Capability claims are backed by uploaded documents rather than self-description, so the interview can be about fit instead of about confirming whether the resume was true.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

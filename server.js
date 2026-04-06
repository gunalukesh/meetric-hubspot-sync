require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const MEETRIC_API_BASE = 'https://api.meetric.com/api';
const MEETRIC_API_TOKEN = process.env.MEETRIC_API_TOKEN;
const MEETRIC_ACCOUNT_ID = process.env.MEETRIC_ACCOUNT_ID;
const HUBSPOT_API_TOKEN = process.env.HUBSPOT_API_TOKEN;
const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const PORT = process.env.PORT || 3000;

const meetricApi = axios.create({
  baseURL: MEETRIC_API_BASE,
  headers: { Authorization: `Bearer ${MEETRIC_API_TOKEN}` },
});

async function getSessionDetails(conversationId) {
  const { data } = await meetricApi.get(`/recordings/sessions/${conversationId}`);
  return data;
}

async function getMeetingSummary(conversationId) {
  try {
    const { data } = await meetricApi.get(
      `/accounts/${MEETRIC_ACCOUNT_ID}/sessions/${conversationId}/meeting-ai-analytics`
    );
    return data;
  } catch (err) {
    console.warn(`Could not fetch AI summary for ${conversationId}:`, err.message);
    return null;
  }
}

const hubspotApi = axios.create({
  baseURL: HUBSPOT_API_BASE,
  headers: { Authorization: `Bearer ${HUBSPOT_API_TOKEN}` },
});

async function findHubSpotContactByEmail(email) {
  try {
    const { data } = await hubspotApi.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: 'EQ',
          value: email,
        }],
      }],
      properties: ['email', 'firstname', 'lastname', 'associatedcompanyid'],
      limit: 1,
    });
    return data.results?.[0] || null;
  } catch (err) {
    console.warn(`HubSpot contact search failed for ${email}:`, err.message);
    return null;
  }
}

async function findHubSpotCompanyByName(companyName) {
  try {
    const { data } = await hubspotApi.post('/crm/v3/objects/companies/search', {
      query: companyName,
      properties: ['name', 'domain'],
      limit: 1,
    });
    return data.results?.[0] || null;
  } catch (err) {
    console.warn(`HubSpot company search failed for "${companyName}":`, err.message);
    return null;
  }
}

async function getAssociatedCompanies(contactId) {
  try {
    const { data } = await hubspotApi.get(
      `/crm/v4/objects/contacts/${contactId}/associations/companies`
    );
    return data.results || [];
  } catch (err) {
    console.warn(`Failed to get associated companies for contact ${contactId}:`, err.message);
    return [];
  }
}

async function updateCompanyWithCallData(companyId, properties) {
  try {
    const { data } = await hubspotApi.patch(
      `/crm/v3/objects/companies/${companyId}`,
      { properties }
    );
    return data;
  } catch (err) {
    console.error(`Failed to update company ${companyId}:`, err.response?.data || err.message);
    throw err;
  }
}

async function ensureCustomProperty() {
  const propertyName = 'meetric_call_notes';
  try {
    await hubspotApi.get(`/crm/v3/properties/companies/${propertyName}`);
    console.log(`Property "${propertyName}" already exists.`);
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`Creating custom property "${propertyName}"...`);
      await hubspotApi.post('/crm/v3/properties/companies', {
        name: propertyName,
        label: 'Meetric Call Notes',
        type: 'string',
        fieldType: 'textarea',
        groupName: 'companyinformation',
        description: 'AI-generated call summaries and recording links from Meetric',
      });
      console.log(`Property "${propertyName}" created successfully.`);
    } else {
      throw err;
    }
  }
}

function extractParticipantEmails(session) {
  const emails = [];
  const participants = session.participants || session.attendees || session.users || [];
  for (const p of participants) {
    if (p.email) emails.push(p.email);
    if (p.mail) emails.push(p.mail);
    if (p.user?.email) emails.push(p.user.email);
  }
  if (session.organizer_email) emails.push(session.organizer_email);
  if (session.calendar_event?.attendees) {
    for (const a of session.calendar_event.attendees) {
      if (a.email) emails.push(a.email);
    }
  }
  return [...new Set(emails)];
}

function formatCallNote(session, summary, conversationId) {
  const meetricLink = `https://app.meetric.com/recording/${conversationId}`;
  const date = session.started_at || session.created_at || session.date || 'Unknown date';
  const title = session.title || session.name || session.meeting_title || 'Untitled Meeting';
  let noteText = `-- Meetric Call: ${title} --\n`;
  noteText += `Date: ${date}\n`;
  noteText += `Recording: ${meetricLink}\n\n`;
  if (summary) {
    const summaryText = summary.summary || summary.meeting_summary || summary.ai_summary || (typeof summary === 'string' ? summary : JSON.stringify(summary));
    noteText += `AI Summary:\n${summaryText}\n`;
  } else {
    noteText += '(AI summary not available)\n';
  }
  return noteText;
}

async function processConversation(conversationId) {
  console.log(`Processing conversation: ${conversationId}`);
  const session = await getSessionDetails(conversationId);
  console.log(`  Title: ${session.title || session.name || 'Unknown'}`);
  const summary = await getMeetingSummary(conversationId);
  let companyId = null;
  const emails = extractParticipantEmails(session);
  console.log(`  Participant emails: ${emails.length > 0 ? emails.join(', ') : 'none'}`);
  for (const email of emails) {
    if (email.endsWith('@pentimenti.ai')) continue;
    const contact = await findHubSpotContactByEmail(email);
    if (contact) {
      console.log(`  Found HubSpot contact: ${contact.properties.email}`);
      const companies = await getAssociatedCompanies(contact.id);
      if (companies.length > 0) {
        companyId = companies[0].toObjectId;
        console.log(`  Matched to company ID: ${companyId}`);
        break;
      }
    }
  }
  if (!companyId) {
    const companyName = session.company?.name || session.company_name || session.organization;
    if (companyName) {
      console.log(`  Trying company name match: "${companyName}"`);
      const company = await findHubSpotCompanyByName(companyName);
      if (company) {
        companyId = company.id;
        console.log(`  Matched to company ID: ${companyId}`);
      }
    }
  }
  if (!companyId) {
    console.warn(`  No matching HubSpot company found for ${conversationId}`);
    return { success: false, reason: 'no_company_match', conversationId };
  }
  const callNote = formatCallNote(session, summary, conversationId);
  let existingNotes = '';
  try {
    const { data: existingCompany } = await hubspotApi.get(
      `/crm/v3/objects/companies/${companyId}`,
      { params: { properties: 'meetric_call_notes' } }
    );
    existingNotes = existingCompany.properties?.meetric_call_notes || '';
  } catch (err) {}
  const separator = '\n\n' + '='.repeat(50) + '\n\n';
  const updatedNotes = existingNotes ? callNote + separator + existingNotes : callNote;
  const truncatedNotes = updatedNotes.substring(0, 65000);
  await updateCompanyWithCallData(companyId, { meetric_call_notes: truncatedNotes });
  console.log(`  Successfully updated HubSpot company ${companyId}`);
  return { success: true, companyId, conversationId };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meetric-hubspot-sync' });
});

app.post('/webhook/meetric', async (req, res) => {
  const { event_type, payload } = req.body;
  console.log(`Webhook received: ${event_type}`);
  if (event_type !== 'conversation_created') {
    return res.json({ status: 'ignored', event_type });
  }
  const conversationId = payload?.conversation_id;
  if (!conversationId) {
    return res.status(400).json({ error: 'Missing conversation_id' });
  }
  res.json({ status: 'accepted', conversation_id: conversationId });
  console.log('Waiting 60s for Meetric to finish processing...');
  await new Promise(resolve => setTimeout(resolve, 60000));
  try {
    const result = await processConversation(conversationId);
    console.log('Result:', JSON.stringify(result));
  } catch (err) {
    console.error(`Error processing ${conversationId}:`, err.message);
  }
});

app.post('/sync/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  try {
    const result = await processConversation(conversationId);
    res.json(result);
  } catch (err) {
    console.error(`Error processing ${conversationId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`Meetric-HubSpot Sync Server running on port ${PORT}`);
  try {
    await ensureCustomProperty();
  } catch (err) {
    console.error('Failed to ensure custom property:', err.message);
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = "https://bhypkprwgxwxivmtfqhd.supabase.co";
const supabaseKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJoeXBrcHJ3Z3h3eGl2bXRmcWhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDMwNTM1MzgsImV4cCI6MjAxODYyOTUzOH0.-DFRZoGagR8O2vhM-0JQ-asnYb5TmypqOFlh-nidxro";

const DEBUG = true; // Set this to false for PROD mode
const OPENAI_KEY = "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";
const TWILIO_ACCOUNT_SID = "ACc5470555925c8cc27db02a0a4adabf5b";
const TWILIO_SERVICE_SID = "MGa57b91e2d11859bf3c921a639c9fe251";
const TWILIO_AUTH_TOKEN = "b98007b66d8a905c333bdf911c5a2732";
const TWILIO_SENDER_NUMBER = "+16466042720";

const supabase = createClient(supabaseUrl, supabaseKey);

// Helper function: Send SMS via Twilio
async function sendSMSTwilio(to: string, message: string) {
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const params = new URLSearchParams();
  params.append("To", to);
  params.append("From", TWILIO_SENDER_NUMBER);
  params.append("Body", message);
  params.append("MessagingServiceSid", TWILIO_SERVICE_SID);

  const authHeader =
    "Basic " + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

  const response = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  console.log(response);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send SMS: ${errorText}`);
  }

  const responseData = await response.json();
  return responseData;
}

// Helper function: Log event to the events table
async function logEvent(type: string, userId: string) {
  const event = { type, user_id: userId, created_at: new Date().toISOString() };
  const { error } = await supabase.from("events").insert([event]);
  if (error) {
    console.log("error from log event ->", error);
    throw new Error("Error logging event");
  }
}

// Helper function: Reset the chat thread
async function resetThread(userId: string) {
  await logEvent("THREAD_RESET", userId);

  const resetMessage = {
    user_id: userId,
    inbound_message: "reset",
    outbound_message: "This conversation has been reset.",
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("messages").insert([resetMessage]);
  if (error) {
    console.log("error from resetThread function ->", error);
    throw new Error("Error saving reset message");
  }
}

// Helper function: Get embeddings from OpenAI
async function getEmbeddings(text: string): Promise<number[]> {
  const response = await fetch(
    "https://api.openai.com/v1/engines/text-embedding-ada-002/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: text }),
    }
  );

  console.log("response from getEmbeddings functions ->", response);

  if (!response.ok) {
    console.log("error from getEmbeddings function");
    throw new Error("Failed to get embeddings from OpenAI");
  }

  const data = await response.json();

  return data.data[0].embedding;
}

// Helper function: Perform a vector search in Supabase
// Note: Supabase now supports pgvector and vector similarity search.
async function vectorSearch(embeddings: number[]): Promise<string> {
  const MAX_RESULTS = 3; // Adjust as needed

  try {
    const { data, error } = await supabase.rpc("find_similar_documents", {
      embedding_array: embeddings, // Pass the embedding you want to compare
      max_results: MAX_RESULTS, // Choose the number of matches
    });

    console.log("from vectorSearch ->", data);
    if (error) {
      console.log("error from vectorSearch function ->", error);
      throw new Error(`Error in vector search: ${error.message}`);
    }

    if (data) {
      console.log("data ->", data);

      // Format the data as needed
      return data.map((doc: any) => `${doc.title}\n${doc.chunk}`).join("\n\n");
    } else {
      return "No results found";
    }
  } catch (err) {
    console.error("Error performing vector search:", err);
    throw err;
  }
}

// Helper function: Get recent messages
async function getRecentMessages(userId: string): Promise<string> {
  // First, find the most recent 'reset' message, if it exists
  const { data: resetData, error: resetError } = await supabase
    .from("messages")
    .select("created_at")
    .eq("user_id", userId)
    .eq("inbound_message", "reset")
    .order("created_at", { ascending: false })
    .limit(1);

  if (resetError) {
    console.log("error from getRecentMessages function ->", resetError);
    throw new Error("Error fetching reset message");
  }

  // Define the query to get recent messages
  let query = supabase
    .from("messages")
    .select("inbound_message, outbound_message")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(24);

  // If a reset message was found, adjust the query to fetch messages only after the reset
  if (resetData && resetData.length > 0) {
    query = query.gt("created_at", resetData[0].created_at);
  }

  // Execute the query
  const { data: messagesData, error: messagesError } = await query;

  if (messagesError) {
    throw new Error("Error fetching recent messages");
  }

  // Format the messages
  const formattedMessages = messagesData.flatMap((msg: any) => [
    { role: "user", content: msg.inbound_message },
    { role: "assistant", content: msg.outbound_message },
  ]);

  console.log(formattedMessages);

  return formattedMessages;
}

function constructPrompt(
  knowledgeBase: string,
  recentMessages: string,
  userMessage: string,
  current_country: string
) {
  let messages: any = [];

  messages.push({
    role: "system",
    content: `System Instructions: You are a personal advisor.\n\nLocation: You are based in ${current_country}.\nKnowledge Base ${knowledgeBase}\n`,
  });

  messages.push(...recentMessages);
  messages.push({ role: "user", content: userMessage });

  return messages;
}

// Helper function: Call OpenAI API
async function callOpenAI(prompt: string): Promise<string> {
  const openaiUrl = "https://api.openai.com/v1/chat/completions";

  const response = await fetch(openaiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo-1106",
      messages: prompt,
    }),
  });

  if (!response.ok) {
    console.log("error from call open api ->", response);

    throw new Error("Failed to get response from OpenAI");
  }

  const data = await response.json();

  return data.choices[0].message.content.trim();
}

// Helper function: Save message record to the database
async function saveMessage(
  userId: string,
  inboundMessage: string,
  llm_prompt: string,
  llm_prompt_char_count: number,
  llm_response_time: number,
  outboundMessage: string
) {
  const message = {
    user_id: userId,
    inbound_message: inboundMessage,
    outbound_message: outboundMessage,
    llm_prompt,
    llm_prompt_char_count,
    llm_response_time,
    created_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("messages").insert([message]);
  if (error) {
    console.log("error from saveMessage function ->", error);
    throw new Error("Error saving message");
  }
}

serve(async (req) => {
  const request = await req.json();

  if (!request) {
    return new Response(JSON.stringify({ status: 400, body: "No data" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const smsBody = request.Body.trim();
  const fromNumber = request.From;

  let country: string = "";

  // Country code handling
  const supportedCountryCodes = ["+1", "+44"];
  if (
    !supportedCountryCodes.includes(fromNumber.substring(0, 3)) &&
    !supportedCountryCodes.includes(fromNumber.substring(0, 2))
  ) {
    console.log("service not provide");
    await sendSMSTwilio(
      fromNumber,
      "Sorry. We do not currently have support for this country."
    );
    return;
  }

  if (fromNumber.substring(0, 2) === "+1") country = "United States";
  if (fromNumber.substring(0, 3) === "+44") country = "United Kingdom";

  // Log MSG_RCVD_FROM_USER event
  await logEvent("MSG_RCVD_FROM_USER", fromNumber);

  // Check for "reset"
  if (DEBUG && smsBody.toLowerCase() === "reset") {
    console.log("debug is true and reset the message");

    await resetThread(fromNumber);
    await sendSMSTwilio(fromNumber, "This conversation has been reset");
    return new Response(
      JSON.stringify({
        status: 200,
        body: "Successfully end the process",
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Call OpenAI for embeddings
  const embeddings = await getEmbeddings(smsBody);

  // Perform vector search in Supabase
  const knowledgeBase = await vectorSearch(embeddings);

  // Get recent messages
  const recentMessages = await getRecentMessages(fromNumber);

  // Construct OpenAI prompt
  const prompt = constructPrompt(
    knowledgeBase,
    recentMessages,
    smsBody,
    country
  );

  // Call OpenAI API for response

  const start_time = new Date().getTime();

  const openaiResponse = await callOpenAI(prompt);

  const end_time = new Date().getTime();

  const llm_response_time = end_time - start_time;

  // Send SMS via Twilio or return JSON in debug mode
  if (!DEBUG) {
    await sendSMSTwilio(fromNumber, openaiResponse);
  }

  const llm_prompt: any = JSON.stringify(prompt);

  var regex = /[a-zA-Z0-9]/g; // only count letters and numbers

  const llm_prompt_char_count = llm_prompt.match(regex).length;

  // Save message and log event
  await saveMessage(
    fromNumber,
    smsBody,
    llm_prompt,
    llm_prompt_char_count,
    Math.floor(llm_response_time / 1000),
    openaiResponse
  );

  await logEvent("MSG_SENT_TO_USER", fromNumber);

  return new Response(
    JSON.stringify({
      status: 200,
      body: "Process completed successfully",
      data: { openaiResponse },
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
});

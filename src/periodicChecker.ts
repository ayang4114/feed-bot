import {Client, TextChannel} from "discord.js";
import {MessageModel} from "./collections/MessageStorage";
import {formatDmMessage} from "./message/formatDmMessage";
import {User, UserModel} from "./collections/UserModel";
import PriorityQueue from 'js-priority-queue';

const compareUsers = function (a: [User, number], b: [User, number]) { return a[1] - b[1]; };
const q = new PriorityQueue({ comparator: compareUsers });

// adding a new user to priority queue
export function addToQueue(user: User): void {
  const d = new Date();
  const newElement: [User, number] = [user, d.getTime() + user.period];
  q.queue(newElement);
}

export function checkUserUpdateEachMinute(client: Client): void {
  setInterval(() => checkUserUpdates(client), 1000);
}

async function checkUserUpdates(client: Client) {
  if (q.length !== 0) {
    let user = q.peek();
    console.log("User is " + user[0].author_id);
    while (user[1] < new Date().getTime()) {
      console.log("Updating user");
      await updateUser(user[0], client);
      user = await q.peek();
      console.log("Done updating");
    }
  }
}

async function updateUser(user: User, client: Client) {
  //dequeue and requeue user
  await console.log("in updateUser");
  const dequeued_item = q.dequeue();
  const dequeued_user = dequeued_item[0];
  const old_period = dequeued_item[1];
  dequeued_user.next_period = old_period + dequeued_user.period;
  addToQueue(dequeued_user);

  // update user with messages that have new reactions
  await sendMsgsWithReactions(dequeued_user, client);
}

function containsKeywords(content: string, keywords: string[]): boolean {
  let result = false;
  keywords.forEach(keyword => {
    if (content.includes(keyword)) {
      result = result || true;
    }
  });
  return result;
}

// periodic check will call this function to update user's dms with new messages crossing the threshold
// function assumes that the user was already dequeued, its next period value was updated, and it was re-queued
async function sendMsgsWithReactions(user: User, client: Client) {
  await console.log("in sendMSG");
  const author_id = user.author_id;
  const user_discord = client.users.fetch(author_id);
  const user_database = await UserModel.findOne({ author_id });

  // CAN CHANGE - hard coded to scan messages in last hour
  const d = new Date();
  const timestamp_thresh: number = d.getTime() - (1000 * 60 * 60);

  let channelArray: string[] = [];
  let serverArray: string[] = [];
  if (user_database != null) {
    channelArray = user_database.channels.map(c => c.channel_id);
    serverArray = user_database.channels.map(c => c.server_id);
  } else {
    console.log('User was null');
  }

  const messages = await MessageModel.find(
    {
      'channel.channel_id': {
        $in: channelArray
      },
      'channel.server_id': {
        $in: serverArray
      },
      created_timestamp: {
        $gte: timestamp_thresh
      }
    });

  // for each new message
  for (const iteration of messages) {
    const channel = await client.channels.fetch(iteration.channel.channel_id);
    if (channel.type != "text") {
      console.log('Error finding text channel in sendMsgsWithReactions');
      continue;
    }

    const m = await (channel as TextChannel).messages.cache.get(iteration.message_id);
    if (m == undefined) {
      console.log('Error finding message in sendMsgsWithReactions');
      continue;
    }
    const reactions = m.reactions.cache.array();

    // count number of unique reactions
    const userSet = new Set();
    for (let i = 0; i < reactions.length; i++) {
      const reaction = reactions[i];
      const users = reaction.users.cache.array();
      for (let j = 0; j < users.length; j++) {
        userSet.add(users[j].id);
      }
    }
    const numUniqueReactors = userSet.size;
    console.log("Message " + iteration.message_id.toString() + " has " + numUniqueReactors.toString() + " reactors");

    // if message contains a keyword and
    // if number of unique reactions crosses threshold, and message hasn't been sent to user before, send message to user
    if (numUniqueReactors >= user.reac_threshold && !iteration.users.includes(author_id) && containsKeywords(m.content, user.keywords)) {
      const message = await formatDmMessage(client, iteration.message_id, iteration.channel.channel_id);
      await (await user_discord).send(message);
      const message_id = iteration.message_id;
      await MessageModel.findOneAndUpdate({
        message_id
      }, {
          $addToSet: {
          users: author_id
        }
      });
    }

    if (m.mentions.users.firstKey() != undefined && !iteration.users.includes(author_id)) {
      const userKeyArr = m.mentions.users.keyArray();
      for (const userKey of userKeyArr) {
        if (m.content.includes("" + userKey) && userKey == author_id) {
          const message = await formatDmMessage(client, iteration.message_id, iteration.channel.channel_id);
          await (await user_discord).send(message);
          const message_id = iteration.message_id;
          await MessageModel.findOneAndUpdate({
            message_id
          }, {
              $addToSet: {
                users: author_id
              }
          });
        }
      }
    }
    else if (m.mentions.roles.firstKey() != undefined && m.guild != null && !iteration.users.includes(author_id)) {
      const userGuildMem = m.guild.members.cache.get(author_id);
      if (userGuildMem != undefined) {
        const roleKeyArr = userGuildMem.roles.cache.keyArray();
        for (const roleKey in roleKeyArr) {
          if (m.content.includes("" + roleKey)) {
            const message = await formatDmMessage(client, iteration.message_id, iteration.channel.channel_id);
            if (message != null) {
              await (await user_discord).send(message);
            }
            const message_id = iteration.message_id;
            await MessageModel.findOneAndUpdate({
              message_id
            }, {
                $addToSet: {
                  users: author_id
                }
            });
          }
        }
      }
    }

  }
}
